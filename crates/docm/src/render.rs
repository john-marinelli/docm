//! Markdown file → Typst document → PDF.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use typst::WorldExt;
use typst::diag::{Severity, SourceDiagnostic};
use typst::syntax::DiagSpan;
use typst_layout::PagedDocument;

use crate::config::{CodeTheme, ConfigSources, LoadedDocument, Loader};
use crate::error::{Location, RenderError, Result, line_column};
use crate::markdown::{self, MapEntry};
use crate::template::{self, Families, Logos};
use crate::world::{DocmWorld, load_font_file, project_file};

/// SHA-256 of each dependency (`None` when it did not exist), recorded when
/// rendering started so a caller can tell whether a result is still current.
pub type Snapshot = Vec<(PathBuf, Option<[u8; 32]>)>;

pub struct Rendered {
    pub document: PagedDocument,
    pub pdf: Vec<u8>,
    pub dependencies: Vec<PathBuf>,
    pub snapshot: Snapshot,
    /// Non-fatal problems (docm's and Typst's), located in the Markdown.
    pub warnings: Vec<RenderError>,
    /// The generated Typst source, for debugging.
    pub typst: String,
}

pub fn snapshot(paths: &[PathBuf]) -> Snapshot {
    paths
        .iter()
        .map(|path| (path.clone(), std::fs::read(path).ok().map(|bytes| Sha256::digest(bytes).into())))
        .collect()
}

pub fn snapshot_current(snapshot: &Snapshot) -> bool {
    snapshot
        .iter()
        .all(|(path, digest)| std::fs::read(path).ok().map(|bytes| <[u8; 32]>::from(Sha256::digest(bytes))) == *digest)
}

/// The generated Typst project for one document, before compilation.
pub struct Prepared {
    pub main: String,
    pub config: String,
    pub assets: Vec<(String, Vec<u8>)>,
    pub fonts: Vec<typst::text::Font>,
    pub map: Vec<MapEntry>,
    pub fences: Vec<markdown::Fence>,
    pub warnings: Vec<RenderError>,
    pub body_offset: usize,
    pub source_path: PathBuf,
    pub dependencies: Vec<PathBuf>,
}

pub fn prepare(source: &Path, sources: &ConfigSources) -> Result<Prepared> {
    let loaded = Loader::new(sources).load(source)?;
    let LoadedDocument { source_path, config, markdown, line_offset, mut dependencies } = loaded;
    let fail = |error: RenderError, dependencies: &[PathBuf]| error.with_dependencies(dependencies.iter().cloned());

    // User fonts: alias → family name read from the file.
    let mut families = BTreeMap::new();
    let mut fonts = Vec::new();
    for (alias, path) in &config.fonts {
        let (faces, family) = load_font_file(path)
            .map_err(|message| fail(RenderError::at(message, Location::start(&source_path)), &dependencies))?;
        families.insert(alias.clone(), family);
        fonts.extend(faces);
    }
    let families = Families::new(families);

    let converted =
        markdown::convert(&markdown, &source_path, line_offset, &config).map_err(|error| fail(error, &dependencies))?;
    dependencies.extend(converted.dependencies.iter().cloned());
    let mut assets = converted.assets;

    let mut register = |path: &Path, name: &str, what: &str| -> Result<String> {
        let data = std::fs::read(path).map_err(|error| {
            fail(
                RenderError::at(
                    format!("Cannot read {what} {}: {error}", path.display()),
                    Location::start(&source_path),
                ),
                &dependencies,
            )
        })?;
        let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("bin").to_ascii_lowercase();
        let virtual_path = format!("/assets/{name}.{extension}");
        assets.push((virtual_path.clone(), data));
        Ok(virtual_path)
    };
    let header_logo = config
        .header
        .logo
        .as_ref()
        .filter(|_| config.header.enabled)
        .map(|logo| register(&logo.path, "header-logo", "logo"))
        .transpose()?;
    let footer_logo = config
        .footer
        .logo
        .as_ref()
        .filter(|_| config.footer.enabled)
        .map(|logo| register(&logo.path, "footer-logo", "logo"))
        .transpose()?;
    let code_theme = match &config.code.theme {
        CodeTheme::File(path) => Some(register(path, "code-theme", "code theme")?),
        _ => None,
    };

    let filename = source_path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let stem = source_path.file_stem().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let title = converted.title.clone().filter(|title| !title.is_empty()).unwrap_or(stem);
    let config_source = template::config_source(&config, &families, &title, code_theme.as_deref());
    let preamble = template::preamble(
        &config,
        Logos { header: header_logo.as_deref(), footer: footer_logo.as_deref() },
        &filename,
        &title,
    );
    let body_offset = preamble.len();
    let main = preamble + &converted.body;
    Ok(Prepared {
        main,
        config: config_source,
        assets,
        fonts,
        map: converted.map,
        fences: converted.fences,
        warnings: converted.warnings,
        body_offset,
        source_path,
        dependencies,
    })
}

pub fn render(source: &Path, sources: &ConfigSources) -> Result<Rendered> {
    let prepared = prepare(source, sources)?;
    // Snapshot inputs as read; a preview publishes only while they still match.
    let snapshot = snapshot(&prepared.dependencies);
    let world = DocmWorld::new(
        prepared.main.clone(),
        vec![("/docm.typ", template::LIBRARY.to_owned()), ("/config.typ", prepared.config.clone())],
        prepared.assets.clone(),
        prepared.fonts.clone(),
    );
    let fail = |diagnostics: &[SourceDiagnostic]| {
        let error = match diagnostics.iter().find(|d| d.severity == Severity::Error).or(diagnostics.first()) {
            Some(diagnostic) => located(&world, diagnostic, &prepared),
            None => RenderError::new("Typst compilation failed"),
        };
        error.with_dependencies(prepared.dependencies.iter().cloned())
    };
    let compiled = typst::compile::<PagedDocument>(&world);
    let document = compiled.output.map_err(|errors| fail(&errors))?;
    let options = typst_pdf::PdfOptions::default();
    let pdf = typst_pdf::pdf(&document, &options).map_err(|errors| fail(&errors))?;
    let mut warnings = prepared.warnings.clone();
    warnings.extend(compiled.warnings.iter().map(|warning| located(&world, warning, &prepared)));
    typst::comemo::evict(10);
    Ok(Rendered {
        document,
        pdf,
        dependencies: prepared.dependencies.clone(),
        snapshot,
        warnings,
        typst: prepared.main,
    })
}

/// A Typst diagnostic with its location mapped back to the Markdown.
fn located(world: &DocmWorld, diagnostic: &SourceDiagnostic, prepared: &Prepared) -> RenderError {
    let mut message = diagnostic.message.to_string();
    for hint in &diagnostic.hints {
        message.push_str(&format!("\n  hint: {}", hint.v));
    }
    // Prefer the error span; otherwise the innermost call site in the document.
    let main = project_file("/main.typ");
    let spans =
        std::iter::once(diagnostic.span).chain(diagnostic.trace.iter().rev().map(|point| DiagSpan::from(point.span)));
    let location = spans
        .filter(|span| span.id() == Some(main))
        .find_map(|span| world.range(span))
        .and_then(|range| locate(&prepared.main, range.start, prepared));
    if let Some(location) = location {
        return RenderError::at(message, location);
    }
    // Errors raised while laying out package content (such as plugin errors)
    // can carry no document span: attribute them to the fence importing the
    // innermost package seen in the error or its trace.
    let spans = std::iter::once(diagnostic.span).chain(diagnostic.trace.iter().map(|point| DiagSpan::from(point.span)));
    let packages: Vec<String> = spans
        .filter_map(|span| match span.id()?.get().root() {
            typst::syntax::VirtualRoot::Package(spec) => Some(spec.to_string()),
            typst::syntax::VirtualRoot::Project => None,
        })
        .collect();
    let fences: Vec<_> = packages
        .iter()
        .map(|package| prepared.fences.iter().filter(|fence| fence.packages.contains(package)).collect::<Vec<_>>())
        .find(|fences| !fences.is_empty())
        .unwrap_or_default();
    match fences.as_slice() {
        [] => RenderError::at(message, Location::start(&prepared.source_path)),
        [fence] => RenderError::at(format!("In this `{}` diagram: {message}", fence.name), fence.location.clone()),
        [fence, ..] => RenderError::at(
            format!("In one of the `{}` diagrams (the first is here): {message}", fence.name),
            fence.location.clone(),
        ),
    }
}

fn locate(main: &str, offset: usize, prepared: &Prepared) -> Option<Location> {
    if offset < prepared.body_offset {
        return None;
    }
    let body_offset = offset - prepared.body_offset;
    let entry = prepared.map.iter().rev().find(|entry| entry.offset <= body_offset)?;
    let body = &main[prepared.body_offset..];
    if entry.verbatim {
        let (line, column) = line_column(&body[entry.offset..], body_offset - entry.offset);
        Some(Location::new(&prepared.source_path, entry.line + line - 1, column))
    } else {
        Some(Location::new(&prepared.source_path, entry.line, entry.column))
    }
}
