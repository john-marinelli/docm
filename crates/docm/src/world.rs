//! The sandboxed Typst world.
//!
//! Typst can read exactly three kinds of file: the generated main source,
//! assets docm registered after validating them (images, logos, code themes),
//! and the vendored package tree compiled into the binary. There is no
//! filesystem root and no package download, so ```` ```typst ```` blocks cannot
//! read arbitrary files or reach the network.

use std::collections::HashMap;
use std::path::Path;
use std::sync::LazyLock;

use include_dir::{Dir, include_dir};
use typst::diag::{FileError, FileResult, PackageError};
use typst::foundations::{Bytes, Datetime, Duration};
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};

static PACKAGES: Dir = include_dir!("$CARGO_MANIFEST_DIR/packages");
static FONTS: Dir = include_dir!("$CARGO_MANIFEST_DIR/fonts");

pub const SANS_FAMILY: &str = "Source Sans 3";
pub const MONO_FAMILY: &str = "Source Code Pro";
pub const MATH_FAMILY: &str = "New Computer Modern Math";

/// Fonts compiled into the binary: docm's prose/code defaults plus Typst's
/// bundled set (which provides New Computer Modern Math).
static BUNDLED_FONTS: LazyLock<Vec<Font>> = LazyLock::new(|| {
    let docm = FONTS
        .dirs()
        .flat_map(|family| family.files())
        .filter(|file| file.path().extension().is_some_and(|ext| ext == "otf"))
        .map(|file| file.contents());
    docm.chain(typst_assets::fonts()).flat_map(|data| Font::iter(Bytes::new(data))).collect()
});

static LIBRARY: LazyLock<LazyHash<Library>> = LazyLock::new(|| LazyHash::new(Library::default()));

/// Is `@preview/NAME:VERSION` bundled?
pub fn package_available(spec: &str) -> bool {
    spec.strip_prefix("@preview/")
        .and_then(|rest| rest.split_once(':'))
        .is_some_and(|(name, version)| PACKAGES.get_dir(format!("preview/{name}/{version}")).is_some())
}

/// Read a user font file and return the family names it provides.
pub fn load_font_file(path: &Path) -> Result<(Vec<Font>, String), String> {
    let data = std::fs::read(path).map_err(|error| format!("Cannot read font {}: {error}", path.display()))?;
    let fonts: Vec<Font> = Font::iter(Bytes::new(data)).collect();
    let family = fonts
        .first()
        .map(|font| font.info().family.clone())
        .ok_or_else(|| format!("{} is not a TrueType/OpenType font Typst can read", path.display()))?;
    Ok((fonts, family))
}

pub struct DocmWorld {
    main: FileId,
    sources: HashMap<FileId, Source>,
    assets: HashMap<FileId, Bytes>,
    book: LazyHash<FontBook>,
    fonts: Vec<Font>,
}

impl DocmWorld {
    /// `sources` and `assets` map virtual project paths (such as `/docm.typ`
    /// or `/assets/1.png`) to their contents. `/main.typ` is the entry point.
    pub fn new(
        main_text: String,
        sources: Vec<(&str, String)>,
        assets: Vec<(String, Vec<u8>)>,
        user_fonts: Vec<Font>,
    ) -> Self {
        let main = project_file("/main.typ");
        let sources = std::iter::once(("/main.typ", main_text))
            .chain(sources)
            .map(|(path, text)| {
                let id = project_file(path);
                (id, Source::new(id, text))
            })
            .collect();
        let assets = assets.into_iter().map(|(path, data)| (project_file(&path), Bytes::new(data))).collect();
        let fonts: Vec<Font> = BUNDLED_FONTS.iter().cloned().chain(user_fonts).collect();
        let book = LazyHash::new(FontBook::from_fonts(&fonts));
        Self { main, sources, assets, book, fonts }
    }

    fn package_file(&self, id: FileId) -> FileResult<&'static [u8]> {
        let rooted = id.get();
        let VirtualRoot::Package(spec) = rooted.root() else {
            return Err(FileError::NotFound(rooted.vpath().get_without_slash().into()));
        };
        if spec.namespace != "preview" {
            return Err(FileError::Package(PackageError::NotFound(spec.clone())));
        }
        let base = format!("preview/{}/{}", spec.name, spec.version);
        if PACKAGES.get_dir(&base).is_none() {
            return Err(FileError::Package(PackageError::Other(Some(
                format!("{spec} is not bundled with docm; only the bundled packages can be imported").into(),
            ))));
        }
        let path = format!("{base}/{}", rooted.vpath().get_without_slash());
        PACKAGES
            .get_file(&path)
            .map(|file| file.contents())
            .ok_or_else(|| FileError::NotFound(rooted.vpath().get_without_slash().into()))
    }
}

pub fn project_file(path: &str) -> FileId {
    RootedPath::new(VirtualRoot::Project, VirtualPath::new(path).expect("valid virtual path")).intern()
}

impl World for DocmWorld {
    fn library(&self) -> &LazyHash<Library> {
        &LIBRARY
    }

    fn book(&self) -> &LazyHash<FontBook> {
        &self.book
    }

    fn main(&self) -> FileId {
        self.main
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        if let Some(source) = self.sources.get(&id) {
            return Ok(source.clone());
        }
        let bytes = self.package_file(id)?;
        let text = std::str::from_utf8(bytes).map_err(|_| FileError::InvalidUtf8)?;
        Ok(Source::new(id, text.into()))
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        if let Some(source) = self.sources.get(&id) {
            return Ok(Bytes::from_string(source.clone()));
        }
        if let Some(bytes) = self.assets.get(&id) {
            return Ok(bytes.clone());
        }
        if matches!(id.get().root(), VirtualRoot::Project) {
            // Only registered assets exist; Typst code cannot reach the filesystem.
            return Err(FileError::AccessDenied);
        }
        self.package_file(id).map(Bytes::new)
    }

    fn font(&self, index: usize) -> Option<Font> {
        self.fonts.get(index).cloned()
    }

    fn today(&self, offset: Option<Duration>) -> Option<Datetime> {
        let now = time::OffsetDateTime::now_utc();
        let now = match offset {
            Some(offset) => now.checked_add(time::Duration::seconds(offset.seconds() as i64))?,
            None => time::OffsetDateTime::now_local().unwrap_or(now),
        };
        Datetime::from_ymd(now.year(), now.month() as u8, now.day())
    }
}
