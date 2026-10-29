//! Layered TOML configuration.
//!
//! Layers merge in order: built-in defaults (`defaults.toml`) → global theme →
//! invocation-directory `theme.toml` → `--config` → document `+++` frontmatter.
//! Every layer is validated strictly (unknown keys, bad units, bad colors)
//! before merging, including values a later layer overrides. Tables merge
//! recursively; scalars and arrays replace. Element typography is inherited
//! from the final body style after merging; box settings are not inherited.

use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde::de::{self, Deserializer};

use crate::error::{Location, RenderError, Result, line_column};

pub const DEFAULTS: &str = include_str!("../../../defaults.toml");

// ---------------------------------------------------------------------------
// Scalar value types

/// A length in typographic points. Accepts `px`, `pt`, `mm`, `cm`, and `in`
/// (96 px per inch, as before). Which values are legal depends on the field.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Length(pub f64);

impl Length {
    pub const ZERO: Length = Length(0.0);

    pub fn pt(self) -> f64 {
        self.0
    }

    fn parse(text: &str, allow_zero: bool, allow_px: bool) -> std::result::Result<Self, String> {
        let trimmed = text.trim();
        let expected = || {
            format!(
                "expected a {} length in {}pt, mm, cm, or in, found {text:?}",
                if allow_zero { "nonnegative" } else { "positive" },
                if allow_px { "px, " } else { "" },
            )
        };
        if allow_zero && trimmed == "0" {
            return Ok(Length::ZERO);
        }
        let split = trimmed.find(|c: char| c.is_ascii_alphabetic()).ok_or_else(expected)?;
        let (number, unit) = trimmed.split_at(split);
        let valid_number = !number.is_empty()
            && number.chars().all(|c| c.is_ascii_digit() || c == '.')
            && number.matches('.').count() <= 1
            && number != ".";
        if !valid_number {
            return Err(expected());
        }
        let amount: f64 = number.parse().map_err(|_| expected())?;
        let factor = match unit {
            "pt" => 1.0,
            "px" if allow_px => 0.75,
            "mm" => 72.0 / 25.4,
            "cm" => 72.0 / 2.54,
            "in" => 72.0,
            _ => return Err(expected()),
        };
        let points = amount * factor;
        if !points.is_finite() || points < 0.0 || (!allow_zero && points == 0.0) {
            return Err(expected());
        }
        Ok(Length(points))
    }
}

impl fmt::Display for Length {
    /// Typst source form.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}pt", trim_float(self.0))
    }
}

pub fn trim_float(value: f64) -> String {
    let text = format!("{value:.4}");
    let text = text.trim_end_matches('0').trim_end_matches('.');
    if text.is_empty() || text == "-0" { "0".into() } else { text.into() }
}

macro_rules! length_kind {
    ($name:ident, $zero:expr, $px:expr) => {
        #[derive(Debug, Clone, Copy, PartialEq)]
        pub struct $name(pub Length);

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
                struct Visitor;
                impl de::Visitor<'_> for Visitor {
                    type Value = $name;
                    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                        f.write_str("a length string such as \"11pt\"")
                    }
                    fn visit_str<E: de::Error>(self, value: &str) -> std::result::Result<$name, E> {
                        Length::parse(value, $zero, $px).map($name).map_err(E::custom)
                    }
                    fn visit_i64<E: de::Error>(self, value: i64) -> std::result::Result<$name, E> {
                        if $zero && value == 0 {
                            Ok($name(Length::ZERO))
                        } else {
                            Err(E::custom("lengths need a unit, such as \"11pt\""))
                        }
                    }
                }
                deserializer.deserialize_any(Visitor)
            }
        }
    };
}

length_kind!(Positive, false, true);
length_kind!(Distance, true, true);
length_kind!(PageLength, false, false);
length_kind!(MarginLength, true, false);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Color {
    Transparent,
    Rgb(u8, u8, u8),
}

impl Color {
    /// Typst expression for a fill/stroke paint.
    pub fn paint(self) -> String {
        match self {
            Color::Transparent => "none".into(),
            Color::Rgb(r, g, b) => format!("rgb({r}, {g}, {b})"),
        }
    }

    /// Typst expression for a text color (which cannot be `none`).
    pub fn text(self) -> String {
        match self {
            Color::Transparent => "rgb(0, 0, 0, 0)".into(),
            Color::Rgb(r, g, b) => format!("rgb({r}, {g}, {b})"),
        }
    }

    pub fn is_transparent(self) -> bool {
        self == Color::Transparent
    }
}

impl<'de> Deserialize<'de> for Color {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        let error = || de::Error::custom(format!("expected #RGB, #RRGGBB, or transparent, found {text:?}"));
        if text == "transparent" {
            return Ok(Color::Transparent);
        }
        let hex = text.strip_prefix('#').ok_or_else(error)?;
        if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(error());
        }
        let channel = |s: &str| u8::from_str_radix(s, 16).map_err(|_| error());
        match hex.len() {
            3 => {
                let expand = |i: usize| channel(&hex[i..i + 1].repeat(2));
                Ok(Color::Rgb(expand(0)?, expand(1)?, expand(2)?))
            }
            6 => Ok(Color::Rgb(channel(&hex[0..2])?, channel(&hex[2..4])?, channel(&hex[4..6])?)),
            _ => Err(error()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Weight(pub u16);

impl<'de> Deserialize<'de> for Weight {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let value = i64::deserialize(deserializer)?;
        if (100..=900).contains(&value) {
            Ok(Weight(value as u16))
        } else {
            Err(de::Error::custom("font_weight must be an integer from 100 to 900"))
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LineHeight(pub f64);

impl<'de> Deserialize<'de> for LineHeight {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let value = f64::deserialize(deserializer)?;
        if value.is_finite() && value > 0.0 {
            Ok(LineHeight(value))
        } else {
            Err(de::Error::custom("line_height must be a positive number"))
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FontStyle {
    Normal,
    Italic,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Align {
    Left,
    Center,
    Right,
    Justify,
}

impl Align {
    pub fn name(self) -> &'static str {
        match self {
            Align::Left => "left",
            Align::Center => "center",
            Align::Right => "right",
            Align::Justify => "justify",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Slot {
    Left,
    Center,
    Right,
}

impl Slot {
    pub fn name(self) -> &'static str {
        match self {
            Slot::Left => "left",
            Slot::Center => "center",
            Slot::Right => "right",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Float {
    Left,
    Right,
    None,
}

/// A font reference: `sans`, `mono`, or an alias declared under `[fonts]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FontRef(pub String);

impl<'de> Deserialize<'de> for FontRef {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value.trim().is_empty() || value.chars().any(char::is_control) {
            return Err(de::Error::custom("expected a nonempty font alias without control characters"));
        }
        if value == "math" {
            return Err(de::Error::custom("the math font is fixed and cannot be used for prose or code"));
        }
        Ok(FontRef(value))
    }
}

/// `{{filename}}`, `{{title}}`, `{{page}}` and `{{pages}}`, with `{{{{`/`}}}}` escapes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecorationText(pub Vec<DecorationPart>);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecorationPart {
    Text(String),
    Filename,
    Title,
    Page,
    Pages,
}

impl DecorationText {
    pub fn parse(value: &str) -> std::result::Result<Self, String> {
        let mut parts = Vec::new();
        let mut text = String::new();
        let mut rest = value;
        let error = "unknown or unterminated decoration token; use {{filename}}, {{title}}, {{page}}, or {{pages}}, and escape literal braces as {{{{ / }}}}";
        while !rest.is_empty() {
            if let Some(after) = rest.strip_prefix("{{{{") {
                text.push_str("{{");
                rest = after;
            } else if let Some(after) = rest.strip_prefix("}}}}") {
                text.push_str("}}");
                rest = after;
            } else if let Some(after) = rest.strip_prefix("{{") {
                let end = after.find("}}").ok_or(error)?;
                let part = match &after[..end] {
                    "filename" => DecorationPart::Filename,
                    "title" => DecorationPart::Title,
                    "page" => DecorationPart::Page,
                    "pages" => DecorationPart::Pages,
                    _ => return Err(error.into()),
                };
                if !text.is_empty() {
                    parts.push(DecorationPart::Text(std::mem::take(&mut text)));
                }
                parts.push(part);
                rest = &after[end + 2..];
            } else if rest.starts_with("}}") {
                return Err(error.into());
            } else {
                let c = rest.chars().next().unwrap();
                text.push(c);
                rest = &rest[c.len_utf8()..];
            }
        }
        if !text.is_empty() {
            parts.push(DecorationPart::Text(text));
        }
        Ok(DecorationText(parts))
    }
}

impl<'de> Deserialize<'de> for DecorationText {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        DecorationText::parse(&value).map_err(de::Error::custom)
    }
}

// ---------------------------------------------------------------------------
// Layer schema. Every field is optional so the same types validate partial
// layers and the merged result. Serde's `flatten` is incompatible with
// `deny_unknown_fields`, so element-specific settings are spelled out by macro.

macro_rules! style_struct {
    ($name:ident { $($(#[$meta:meta])* $field:ident : $ty:ty),* $(,)? }) => {
        #[derive(Debug, Clone, Default, Deserialize)]
        #[serde(deny_unknown_fields)]
        pub struct $name {
            pub font: Option<FontRef>,
            pub font_size: Option<Positive>,
            pub font_weight: Option<Weight>,
            pub font_style: Option<FontStyle>,
            pub text_align: Option<Align>,
            pub line_height: Option<LineHeight>,
            pub color: Option<Color>,
            pub background: Option<Color>,
            pub space_before: Option<Distance>,
            pub space_after: Option<Distance>,
            pub padding: Option<Distance>,
            pub border_color: Option<Color>,
            pub border_width: Option<Distance>,
            pub border_radius: Option<Distance>,
            $($(#[$meta])* pub $field: Option<$ty>,)*
        }

        impl $name {
            pub fn style(&self) -> StyleLayer {
                StyleLayer {
                    font: self.font.clone(),
                    font_size: self.font_size,
                    font_weight: self.font_weight,
                    font_style: self.font_style,
                    text_align: self.text_align,
                    line_height: self.line_height,
                    color: self.color,
                    background: self.background,
                    space_before: self.space_before,
                    space_after: self.space_after,
                    padding: self.padding,
                    border_color: self.border_color,
                    border_width: self.border_width,
                    border_radius: self.border_radius,
                }
            }
        }
    };
}

style_struct!(StyleLayer {});
style_struct!(LinkLayer { underline: bool });
style_struct!(ListLayer { indent: Distance });
style_struct!(TableLayer { header_background: Color, stripe_background: Color });
style_struct!(CodeLayer {
    /// `default` (Typst's built-in highlighting), `none`, or a path to a `.tmTheme` file.
    theme: String,
    line_numbers: bool,
});
style_struct!(ImageLayer { align: Slot });
style_struct!(DiagramLayer {
    width: Positive,
    height: Positive,
    charts: BTreeMap<String, ChartLayer>,
    packages: BTreeMap<String, PackageLayer>,
});
style_struct!(ChartLayer { width: Positive, height: Positive });

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PageLayer {
    pub size: Option<PageSize>,
    pub orientation: Option<Orientation>,
    pub width: Option<PageLength>,
    pub height: Option<PageLength>,
    pub margins: Option<MarginsLayer>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum PageSize {
    A4,
    A3,
    A5,
    Letter,
    Legal,
    #[serde(rename = "custom")]
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Orientation {
    Portrait,
    Landscape,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MarginsLayer {
    pub top: Option<MarginLength>,
    pub bottom: Option<MarginLength>,
    pub left: Option<MarginLength>,
    pub right: Option<MarginLength>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DocumentLayer {
    pub toc: Option<bool>,
    pub number_headings: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HeadingsLayer {
    pub h1: Option<StyleLayer>,
    pub h2: Option<StyleLayer>,
    pub h3: Option<StyleLayer>,
    pub h4: Option<StyleLayer>,
    pub h5: Option<StyleLayer>,
    pub h6: Option<StyleLayer>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FormatMacroLayer {
    pub text_align: Option<Slot>,
    pub float: Option<Float>,
    pub width: Option<Positive>,
    pub height: Option<Positive>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MathLayer {
    pub font_size: Option<Positive>,
    pub color: Option<Color>,
    pub space_before: Option<Distance>,
    pub space_after: Option<Distance>,
    pub macros: Option<BTreeMap<String, TexMacroLayer>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TexMacroLayer {
    pub args: Option<u8>,
    pub body: Option<String>,
}

/// A diagram fence: ```` ```NAME ```` imports packages and wraps its body.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PackageLayer {
    /// Package specs such as `@preview/chronos:0.3.0`.
    pub imports: Option<Vec<String>>,
    /// Typst code with `{{body}}` (verbatim Typst) or `{{body_string}}` (the
    /// body as a Typst string literal) where the fence contents go.
    pub wrap: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DecorationLayer {
    pub enabled: Option<bool>,
    pub left: Option<DecorationText>,
    pub center: Option<DecorationText>,
    pub right: Option<DecorationText>,
    pub font: Option<FontRef>,
    pub font_size: Option<Positive>,
    pub font_weight: Option<Weight>,
    pub font_style: Option<FontStyle>,
    pub line_height: Option<LineHeight>,
    pub color: Option<Color>,
    pub logo: Option<LogoLayer>,
}

/// `logo = false` suppresses an inherited logo.
#[derive(Debug, Clone)]
pub enum LogoLayer {
    Off,
    On(LogoFields),
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LogoFields {
    pub path: Option<String>,
    pub position: Option<Slot>,
    pub width: Option<Positive>,
    pub height: Option<Positive>,
}

impl<'de> Deserialize<'de> for LogoLayer {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct Visitor;
        impl<'de> de::Visitor<'de> for Visitor {
            type Value = LogoLayer;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("false or a logo table")
            }
            fn visit_bool<E: de::Error>(self, value: bool) -> std::result::Result<LogoLayer, E> {
                if value { Err(E::custom("logo must be false or a table with a path")) } else { Ok(LogoLayer::Off) }
            }
            fn visit_map<A: de::MapAccess<'de>>(self, map: A) -> std::result::Result<LogoLayer, A::Error> {
                LogoFields::deserialize(de::value::MapAccessDeserializer::new(map)).map(LogoLayer::On)
            }
        }
        deserializer.deserialize_any(Visitor)
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Layer {
    pub page: Option<PageLayer>,
    pub document: Option<DocumentLayer>,
    pub fonts: Option<BTreeMap<String, String>>,
    #[serde(rename = "macro")]
    pub macros: Option<BTreeMap<String, FormatMacroLayer>>,
    pub body: Option<StyleLayer>,
    pub headings: Option<HeadingsLayer>,
    pub paragraph: Option<StyleLayer>,
    pub link: Option<LinkLayer>,
    pub list: Option<ListLayer>,
    pub table: Option<TableLayer>,
    pub blockquote: Option<StyleLayer>,
    pub inline_code: Option<StyleLayer>,
    pub code: Option<CodeLayer>,
    pub math: Option<MathLayer>,
    pub diagram: Option<DiagramLayer>,
    pub image: Option<ImageLayer>,
    pub footnotes: Option<StyleLayer>,
    pub rule: Option<StyleLayer>,
    pub header: Option<DecorationLayer>,
    pub footer: Option<DecorationLayer>,
}

// ---------------------------------------------------------------------------
// Resolved configuration

#[derive(Debug, Clone, PartialEq)]
pub struct Style {
    pub font: String,
    pub font_size: Length,
    pub font_weight: u16,
    pub italic: bool,
    pub text_align: Align,
    pub line_height: f64,
    pub color: Color,
    pub background: Color,
    pub space_before: Length,
    pub space_after: Length,
    pub padding: Length,
    pub border_color: Color,
    pub border_width: Length,
    pub border_radius: Length,
}

#[derive(Debug, Clone)]
pub struct Page {
    pub width: Length,
    pub height: Length,
    pub margin_top: Length,
    pub margin_bottom: Length,
    pub margin_left: Length,
    pub margin_right: Length,
}

#[derive(Debug, Clone)]
pub struct FormatMacro {
    pub text_align: Option<Slot>,
    pub float: Option<Float>,
    pub width: Option<Length>,
    pub height: Option<Length>,
}

#[derive(Debug, Clone)]
pub struct TexMacro {
    pub args: u8,
    pub body: String,
}

#[derive(Debug, Clone)]
pub struct Math {
    pub font_size: Length,
    pub color: Color,
    pub space_before: Length,
    pub space_after: Length,
    pub macros: BTreeMap<String, TexMacro>,
}

#[derive(Debug, Clone)]
pub enum CodeTheme {
    Default,
    None,
    File(PathBuf),
}

#[derive(Debug, Clone)]
pub struct Code {
    pub style: Style,
    pub theme: CodeTheme,
    pub line_numbers: bool,
}

#[derive(Debug, Clone)]
pub struct Chart {
    pub style: Style,
    pub width: Option<Length>,
    pub height: Option<Length>,
}

#[derive(Debug, Clone)]
pub struct Package {
    pub imports: Vec<String>,
    pub wrap: String,
}

#[derive(Debug, Clone)]
pub struct Diagram {
    pub chart: Chart,
    /// One-based diagram number (in document order, across all diagram fences).
    pub charts: BTreeMap<usize, Chart>,
    pub packages: BTreeMap<String, Package>,
}

impl Diagram {
    pub fn chart(&self, number: usize) -> &Chart {
        self.charts.get(&number).unwrap_or(&self.chart)
    }
}

#[derive(Debug, Clone)]
pub struct Logo {
    pub path: PathBuf,
    pub position: Slot,
    pub width: Length,
    pub height: Length,
}

#[derive(Debug, Clone)]
pub struct Decoration {
    pub enabled: bool,
    pub left: DecorationText,
    pub center: DecorationText,
    pub right: DecorationText,
    pub font: String,
    pub font_size: Length,
    pub font_weight: u16,
    pub italic: bool,
    pub line_height: f64,
    pub color: Color,
    pub logo: Option<Logo>,
}

impl Decoration {
    pub fn is_empty(&self) -> bool {
        !self.enabled
            || (self.left.0.is_empty() && self.center.0.is_empty() && self.right.0.is_empty() && self.logo.is_none())
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub page: Page,
    pub toc: bool,
    pub number_headings: bool,
    /// Alias → absolute font file path.
    pub fonts: BTreeMap<String, PathBuf>,
    pub macros: BTreeMap<String, FormatMacro>,
    pub body: Style,
    pub headings: [Style; 6],
    pub paragraph: Style,
    pub link: Style,
    pub link_underline: bool,
    pub list: Style,
    pub list_indent: Length,
    pub table: Style,
    pub table_header_background: Color,
    pub table_stripe_background: Color,
    pub blockquote: Style,
    pub inline_code: Style,
    pub code: Code,
    pub math: Math,
    pub diagram: Diagram,
    pub image: Style,
    pub image_align: Slot,
    pub footnotes: Style,
    pub rule: Style,
    pub header: Decoration,
    pub footer: Decoration,
}

// ---------------------------------------------------------------------------
// Loading

/// Where each optional or explicit configuration layer comes from.
#[derive(Debug, Clone)]
pub struct ConfigSources {
    pub cwd: PathBuf,
    pub global_theme: PathBuf,
    pub explicit: Option<PathBuf>,
}

impl ConfigSources {
    pub fn for_invocation(cwd: PathBuf, explicit: Option<PathBuf>) -> Self {
        let explicit = explicit.map(|path| cwd.join(path));
        Self { global_theme: global_theme_path(), cwd, explicit }
    }
}

/// `~/Library/Application Support/docm/theme.toml` on macOS; on Linux
/// `$XDG_CONFIG_HOME/docm/theme.toml`, falling back to `~/.config` when
/// XDG_CONFIG_HOME is unset, empty, or relative.
pub fn global_theme_path() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    if cfg!(target_os = "macos") {
        return home.join("Library/Application Support/docm/theme.toml");
    }
    let xdg = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).filter(|path| path.is_absolute());
    xdg.unwrap_or_else(|| home.join(".config")).join("docm/theme.toml")
}

/// The Markdown body and its configuration.
#[derive(Debug, Clone)]
pub struct LoadedDocument {
    pub source_path: PathBuf,
    pub config: Config,
    pub markdown: String,
    /// Source lines removed (frontmatter) before `markdown` begins.
    pub line_offset: usize,
    /// Every file read or probed, including missing optional themes.
    pub dependencies: Vec<PathBuf>,
}

pub struct Loader<'a> {
    sources: &'a ConfigSources,
    dependencies: Vec<PathBuf>,
}

impl<'a> Loader<'a> {
    pub fn new(sources: &'a ConfigSources) -> Self {
        Self { sources, dependencies: Vec::new() }
    }

    fn depend(&mut self, path: &Path) {
        if !self.dependencies.iter().any(|known| known == path) {
            self.dependencies.push(path.to_path_buf());
        }
    }

    fn fail(&self, error: RenderError) -> RenderError {
        error.with_dependencies(self.dependencies.iter().cloned())
    }

    fn read(&mut self, path: &Path, optional: bool) -> Result<Option<String>> {
        self.depend(path);
        match std::fs::read(path) {
            Ok(bytes) => {
                let text = String::from_utf8(bytes)
                    .map_err(|_| self.fail(RenderError::at("File is not valid UTF-8", Location::start(path))))?;
                Ok(Some(text.strip_prefix('\u{feff}').map(str::to_owned).unwrap_or(text)))
            }
            Err(error) if optional && error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => {
                Err(self
                    .fail(RenderError::at(format!("Cannot read {}: {error}", path.display()), Location::start(path))))
            }
        }
    }

    /// Parse and strictly validate one layer, resolving its asset paths
    /// relative to the declaring file.
    fn layer(&mut self, text: &str, path: &Path, line_offset: usize) -> Result<toml::Table> {
        let locate = |span: Option<std::ops::Range<usize>>| {
            let (line, column) = span.map_or((1, 1), |span| line_column(text, span.start));
            Location::new(path, line + line_offset, column)
        };
        let mut table: toml::Table = toml::from_str(text).map_err(|error| {
            self.fail(RenderError::at(
                format!("Invalid TOML in {}: {}", path.display(), error.message()),
                locate(error.span()),
            ))
        })?;
        // Validate with spans first so errors point at the offending key.
        let _: Layer = toml::from_str(text).map_err(|error| {
            self.fail(RenderError::at(
                format!("Invalid configuration in {}: {}", path.display(), error.message()),
                locate(error.span()),
            ))
        })?;
        let directory = path.parent().unwrap_or(Path::new("/")).to_path_buf();
        self.resolve_paths(&mut table, &directory, path, text, line_offset)?;
        Ok(table)
    }

    fn resolve_paths(
        &mut self,
        table: &mut toml::Table,
        directory: &Path,
        file: &Path,
        text: &str,
        line_offset: usize,
    ) -> Result<()> {
        let resolve = |loader: &mut Self, value: &mut toml::Value, what: &str| -> Result<()> {
            let toml::Value::String(raw) = value else { return Ok(()) };
            let invalid = raw.trim().is_empty() || raw.contains('\0') || has_url_scheme(raw);
            if invalid {
                let line = text.lines().position(|line| line.contains(raw.as_str())).map_or(1, |l| l + 1);
                return Err(loader.fail(RenderError::at(
                    format!("{what} must be a local filesystem path, not a URL"),
                    Location::new(file, line + line_offset, 1),
                )));
            }
            let resolved = directory.join(&*raw);
            loader.depend(&resolved);
            *raw = resolved.to_string_lossy().into_owned();
            Ok(())
        };
        if let Some(toml::Value::Table(fonts)) = table.get_mut("fonts") {
            for (alias, value) in fonts.iter_mut() {
                let lower = value.as_str().unwrap_or_default().to_ascii_lowercase();
                if !(lower.ends_with(".ttf") || lower.ends_with(".otf") || lower.ends_with(".ttc")) {
                    return Err(self.fail(RenderError::at(
                        format!("Font {alias:?} must be a local .ttf, .otf, or .ttc file (Typst cannot read WOFF)"),
                        Location::new(file, line_offset + 1, 1),
                    )));
                }
                resolve(self, value, "Font")?;
            }
        }
        for name in ["header", "footer"] {
            if let Some(toml::Value::Table(decoration)) = table.get_mut(name)
                && let Some(toml::Value::Table(logo)) = decoration.get_mut("logo")
                && let Some(path) = logo.get_mut("path")
            {
                resolve(self, path, "Logo")?;
            }
        }
        if let Some(toml::Value::Table(code)) = table.get_mut("code")
            && let Some(theme) = code.get_mut("theme")
            && !matches!(theme.as_str(), Some("default" | "none"))
        {
            resolve(self, theme, "Code theme")?;
        }
        Ok(())
    }

    pub fn load(mut self, source_path: &Path) -> Result<LoadedDocument> {
        let cwd = self.sources.cwd.clone();
        let source = cwd.join(source_path);
        let global = self.sources.global_theme.clone();
        let local = cwd.join("theme.toml");
        let explicit = self.sources.explicit.clone();
        for path in [Some(&source), Some(&global), Some(&local), explicit.as_ref()].into_iter().flatten() {
            self.depend(path);
        }

        let raw = self.read(&source, false)?.unwrap_or_default();
        let (markdown, line_offset, frontmatter) =
            split_frontmatter(&raw).map_err(|message| self.fail(RenderError::at(message, Location::start(&source))))?;
        let frontmatter = match frontmatter {
            Some(text) => Some(self.layer(text, &source, 1)?),
            None => None,
        };

        let defaults_path = PathBuf::from("<built-in defaults>");
        let mut merged = self.layer(DEFAULTS, &defaults_path, 0)?;
        // An explicit path equal to an automatic one still applies again here.
        let layers = [(global, true), (local, true)].into_iter().chain(explicit.map(|path| (path, false)));
        for (path, optional) in layers {
            if let Some(text) = self.read(&path, optional)? {
                let layer = self.layer(&text, &path, 0)?;
                merge(&mut merged, layer);
            }
        }
        if let Some(layer) = frontmatter {
            merge(&mut merged, layer);
        }

        let layer: Layer = toml::Value::Table(merged).try_into().map_err(|error: toml::de::Error| {
            self.fail(RenderError::at(
                format!("Invalid merged configuration: {}", error.message()),
                Location::start(&source),
            ))
        })?;
        let config = resolve(layer).map_err(|message| {
            self.fail(RenderError::at(format!("Invalid merged configuration: {message}"), Location::start(&source)))
        })?;
        Ok(LoadedDocument {
            source_path: source,
            config,
            markdown: markdown.to_owned(),
            line_offset,
            dependencies: self.dependencies,
        })
    }
}

pub fn has_url_scheme(value: &str) -> bool {
    let mut chars = value.chars();
    let starts_alpha = chars.next().is_some_and(|c| c.is_ascii_alphabetic());
    let scheme_len = value.find(':');
    starts_alpha
        && scheme_len.is_some_and(|end| {
            end > 1 // `C:` drive letters are not schemes.
                && value[..end].chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        })
}

/// Split `+++` TOML frontmatter (opening line must be the first line).
/// Returns the Markdown body, number of removed lines, and the TOML text.
pub fn split_frontmatter(text: &str) -> std::result::Result<(&str, usize, Option<&str>), String> {
    let opening = if text.starts_with("+++\n") {
        4
    } else if text.starts_with("+++\r\n") {
        5
    } else {
        return Ok((text, 0, None));
    };
    let remainder = &text[opening..];
    let mut offset = 0;
    for line in remainder.split_inclusive('\n') {
        let content = line.trim_end_matches('\n').trim_end_matches('\r');
        if content == "+++" {
            let toml = &remainder[..offset];
            let removed = &text[..opening + offset + line.len()];
            let mut lines = removed.matches('\n').count();
            if !removed.ends_with('\n') {
                lines += 1; // A closing delimiter at EOF still occupies a line.
            }
            return Ok((&text[removed.len()..], lines, Some(toml)));
        }
        offset += line.len();
    }
    Err("Unterminated TOML frontmatter; expected a closing +++ line".into())
}

/// Tables merge recursively; scalars and arrays replace.
pub fn merge(lower: &mut toml::Table, upper: toml::Table) {
    for (key, value) in upper {
        match (lower.get_mut(&key), value) {
            (Some(toml::Value::Table(below)), toml::Value::Table(above)) => merge(below, above),
            (_, value) => {
                lower.insert(key, value);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Resolution

fn require<T>(value: Option<T>, name: &str) -> std::result::Result<T, String> {
    value.ok_or_else(|| format!("{name} is required"))
}

fn resolve_style(layer: &StyleLayer, inherit: &Style) -> Style {
    Style {
        font: layer.font.as_ref().map_or_else(|| inherit.font.clone(), |font| font.0.clone()),
        font_size: layer.font_size.map_or(inherit.font_size, |v| v.0),
        font_weight: layer.font_weight.map_or(inherit.font_weight, |v| v.0),
        italic: layer.font_style.map_or(inherit.italic, |v| v == FontStyle::Italic),
        text_align: layer.text_align.unwrap_or(inherit.text_align),
        line_height: layer.line_height.map_or(inherit.line_height, |v| v.0),
        color: layer.color.unwrap_or(inherit.color),
        // Box settings are never inherited.
        background: layer.background.unwrap_or(Color::Transparent),
        space_before: layer.space_before.map_or(Length::ZERO, |v| v.0),
        space_after: layer.space_after.map_or(Length::ZERO, |v| v.0),
        padding: layer.padding.map_or(Length::ZERO, |v| v.0),
        border_color: layer.border_color.unwrap_or(inherit.color),
        border_width: layer.border_width.map_or(Length::ZERO, |v| v.0),
        border_radius: layer.border_radius.map_or(Length::ZERO, |v| v.0),
    }
}

fn valid_macro_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Merge a layer's style over another (used for chart overrides, which
/// inherit the final global diagram settings).
fn overlay(base: &StyleLayer, top: &StyleLayer) -> StyleLayer {
    StyleLayer {
        font: top.font.clone().or_else(|| base.font.clone()),
        font_size: top.font_size.or(base.font_size),
        font_weight: top.font_weight.or(base.font_weight),
        font_style: top.font_style.or(base.font_style),
        text_align: top.text_align.or(base.text_align),
        line_height: top.line_height.or(base.line_height),
        color: top.color.or(base.color),
        background: top.background.or(base.background),
        space_before: top.space_before.or(base.space_before),
        space_after: top.space_after.or(base.space_after),
        padding: top.padding.or(base.padding),
        border_color: top.border_color.or(base.border_color),
        border_width: top.border_width.or(base.border_width),
        border_radius: top.border_radius.or(base.border_radius),
    }
}

pub fn resolve(layer: Layer) -> std::result::Result<Config, String> {
    // Page geometry
    let page = layer.page.unwrap_or_default();
    let size = require(page.size, "page.size")?;
    let landscape = require(page.orientation, "page.orientation")? == Orientation::Landscape;
    let (width, height) = match size {
        PageSize::Custom => {
            let width = page.width.ok_or("Custom page size requires page.width")?.0;
            let height = page.height.ok_or("Custom page size requires page.height")?.0;
            (width, height)
        }
        named => {
            if page.width.is_some() || page.height.is_some() {
                return Err("page.width and page.height are allowed only when page.size = \"custom\"".into());
            }
            let (w, h) = match named {
                PageSize::A4 => (210.0, 297.0),
                PageSize::A3 => (297.0, 420.0),
                PageSize::A5 => (148.0, 210.0),
                PageSize::Letter => (215.9, 279.4),
                PageSize::Legal => (215.9, 355.6),
                PageSize::Custom => unreachable!(),
            };
            (Length(w * 72.0 / 25.4), Length(h * 72.0 / 25.4))
        }
    };
    let (width, height) = if landscape { (height, width) } else { (width, height) };
    let margins = page.margins.unwrap_or_default();
    let margin = |value: Option<MarginLength>, name: &str| require(value, name).map(|m| m.0);
    let page = Page {
        width,
        height,
        margin_top: margin(margins.top, "page.margins.top")?,
        margin_bottom: margin(margins.bottom, "page.margins.bottom")?,
        margin_left: margin(margins.left, "page.margins.left")?,
        margin_right: margin(margins.right, "page.margins.right")?,
    };
    if page.margin_left.0 + page.margin_right.0 >= page.width.0 {
        return Err("Left and right margins leave no printable width".into());
    }
    if page.margin_top.0 + page.margin_bottom.0 >= page.height.0 {
        return Err("Top and bottom margins leave no printable height".into());
    }

    let document = layer.document.unwrap_or_default();

    // Fonts
    let fonts: BTreeMap<String, PathBuf> =
        layer.fonts.unwrap_or_default().into_iter().map(|(alias, path)| (alias, PathBuf::from(path))).collect();
    for alias in fonts.keys() {
        if alias.trim().is_empty() || alias.chars().any(char::is_control) {
            return Err(format!("Invalid font alias {alias:?}"));
        }
        if matches!(alias.as_str(), "sans" | "mono" | "math") {
            return Err(format!("Font alias {alias:?} cannot shadow sans, mono, or math"));
        }
    }

    // Formatting macros
    let mut macros = BTreeMap::new();
    for (name, value) in layer.macros.unwrap_or_default() {
        if !valid_macro_name(&name) {
            return Err(format!(
                "Formatting macro name {name:?} must start with an ASCII letter and contain only ASCII letters, digits, underscores, or hyphens"
            ));
        }
        if value.text_align.is_none() && value.float.is_none() && value.width.is_none() && value.height.is_none() {
            return Err(format!("Formatting macro {name:?} requires at least one setting"));
        }
        macros.insert(
            name,
            FormatMacro {
                text_align: value.text_align,
                float: value.float,
                width: value.width.map(|v| v.0),
                height: value.height.map(|v| v.0),
            },
        );
    }

    // Body is complete; other elements inherit typography from it.
    let body_layer = layer.body.unwrap_or_default();
    let body = Style {
        font: require(body_layer.font.clone(), "body.font")?.0,
        font_size: require(body_layer.font_size, "body.font_size")?.0,
        font_weight: require(body_layer.font_weight, "body.font_weight")?.0,
        italic: require(body_layer.font_style, "body.font_style")? == FontStyle::Italic,
        text_align: require(body_layer.text_align, "body.text_align")?,
        line_height: require(body_layer.line_height, "body.line_height")?.0,
        color: require(body_layer.color, "body.color")?,
        background: body_layer.background.unwrap_or(Color::Transparent),
        space_before: body_layer.space_before.map_or(Length::ZERO, |v| v.0),
        space_after: body_layer.space_after.map_or(Length::ZERO, |v| v.0),
        padding: body_layer.padding.map_or(Length::ZERO, |v| v.0),
        border_color: body_layer.border_color.unwrap_or(Color::Transparent),
        border_width: body_layer.border_width.map_or(Length::ZERO, |v| v.0),
        border_radius: body_layer.border_radius.map_or(Length::ZERO, |v| v.0),
    };
    let style = |layer: Option<StyleLayer>| resolve_style(&layer.unwrap_or_default(), &body);
    let headings = layer.headings.unwrap_or_default();
    let headings = [headings.h1, headings.h2, headings.h3, headings.h4, headings.h5, headings.h6].map(style);

    let link = layer.link.unwrap_or_default();
    let list = layer.list.unwrap_or_default();
    let table = layer.table.unwrap_or_default();
    let code = layer.code.unwrap_or_default();
    let image = layer.image.unwrap_or_default();

    let math = layer.math.unwrap_or_default();
    let mut tex_macros = BTreeMap::new();
    for (name, value) in math.macros.unwrap_or_default() {
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphabetic()) {
            return Err(format!(
                "Math macro name {name:?} must contain only ASCII letters, without a leading backslash"
            ));
        }
        let args = value.args.unwrap_or(0);
        if args > 9 {
            return Err(format!("Math macro \\{name} may take at most 9 arguments"));
        }
        let body = value.body.ok_or_else(|| format!("Math macro \\{name} requires a body"))?;
        tex_macros.insert(name, TexMacro { args, body });
    }

    let diagram = layer.diagram.unwrap_or_default();
    let diagram_style = diagram.style();
    let chart = Chart {
        style: resolve_style(&diagram_style, &body),
        width: diagram.width.map(|v| v.0),
        height: diagram.height.map(|v| v.0),
    };
    let mut charts = BTreeMap::new();
    for (number, override_layer) in diagram.charts.unwrap_or_default() {
        let parsed = number
            .parse::<usize>()
            .ok()
            .filter(|n| *n > 0 && n.to_string() == number)
            .ok_or_else(|| format!("diagram.charts.{number}: expected a canonical positive diagram number"))?;
        charts.insert(
            parsed,
            Chart {
                style: resolve_style(&overlay(&diagram_style, &override_layer.style()), &body),
                width: override_layer.width.map(|v| v.0).or(chart.width),
                height: override_layer.height.map(|v| v.0).or(chart.height),
            },
        );
    }
    let mut packages = BTreeMap::new();
    for (name, package) in diagram.packages.unwrap_or_default() {
        if !valid_macro_name(&name) || name == "typst" {
            return Err(format!("diagram.packages.{name}: invalid fence name"));
        }
        let imports = package.imports.unwrap_or_default();
        for spec in &imports {
            if !spec.starts_with("@preview/") || !spec.contains(':') {
                return Err(format!(
                    "diagram.packages.{name}: imports must be @preview/NAME:VERSION specs, found {spec:?}"
                ));
            }
        }
        let wrap = package.wrap.ok_or_else(|| format!("diagram.packages.{name} requires wrap"))?;
        if !wrap.contains("{{body}}") && !wrap.contains("{{body_string}}") {
            return Err(format!("diagram.packages.{name}.wrap must contain {{{{body}}}} or {{{{body_string}}}}"));
        }
        packages.insert(name, Package { imports, wrap });
    }

    let decoration = |layer: Option<DecorationLayer>, name: &str| -> std::result::Result<Decoration, String> {
        let layer = layer.unwrap_or_default();
        let logo = match layer.logo {
            None | Some(LogoLayer::Off) => None,
            Some(LogoLayer::On(fields)) => Some(Logo {
                path: PathBuf::from(fields.path.ok_or_else(|| format!("{name}.logo requires path"))?),
                position: fields.position.unwrap_or(Slot::Left),
                width: fields.width.map_or(Length(18.0 * 72.0 / 25.4), |v| v.0),
                height: fields.height.map_or(Length(8.0 * 72.0 / 25.4), |v| v.0),
            }),
        };
        Ok(Decoration {
            enabled: require(layer.enabled, &format!("{name}.enabled"))?,
            left: layer.left.unwrap_or(DecorationText(Vec::new())),
            center: layer.center.unwrap_or(DecorationText(Vec::new())),
            right: layer.right.unwrap_or(DecorationText(Vec::new())),
            font: require(layer.font, &format!("{name}.font"))?.0,
            font_size: require(layer.font_size, &format!("{name}.font_size"))?.0,
            font_weight: require(layer.font_weight, &format!("{name}.font_weight"))?.0,
            italic: require(layer.font_style, &format!("{name}.font_style"))? == FontStyle::Italic,
            line_height: require(layer.line_height, &format!("{name}.line_height"))?.0,
            color: require(layer.color, &format!("{name}.color"))?,
            logo,
        })
    };

    let config = Config {
        page,
        toc: require(document.toc, "document.toc")?,
        number_headings: require(document.number_headings, "document.number_headings")?,
        fonts,
        macros,
        headings,
        paragraph: style(layer.paragraph),
        link: resolve_style(&link.style(), &body),
        link_underline: require(link.underline, "link.underline")?,
        list: resolve_style(&list.style(), &body),
        list_indent: list.indent.map_or(Length::ZERO, |v| v.0),
        table: resolve_style(&table.style(), &body),
        table_header_background: table.header_background.unwrap_or(Color::Transparent),
        table_stripe_background: table.stripe_background.unwrap_or(Color::Transparent),
        blockquote: style(layer.blockquote),
        inline_code: style(layer.inline_code),
        code: Code {
            style: resolve_style(&code.style(), &body),
            theme: match code.theme.as_deref() {
                None | Some("default") => CodeTheme::Default,
                Some("none") => CodeTheme::None,
                Some(path) => {
                    if !path.to_ascii_lowercase().ends_with(".tmtheme") {
                        return Err(format!(
                            "code.theme must be \"default\", \"none\", or a path to a .tmTheme file, found {path:?}"
                        ));
                    }
                    CodeTheme::File(PathBuf::from(path))
                }
            },
            line_numbers: require(code.line_numbers, "code.line_numbers")?,
        },
        math: Math {
            font_size: require(math.font_size, "math.font_size")?.0,
            color: require(math.color, "math.color")?,
            space_before: math.space_before.map_or(Length::ZERO, |v| v.0),
            space_after: math.space_after.map_or(Length::ZERO, |v| v.0),
            macros: tex_macros,
        },
        diagram: Diagram { chart, charts, packages },
        image: resolve_style(&image.style(), &body),
        image_align: image.align.unwrap_or(Slot::Center),
        footnotes: style(layer.footnotes),
        rule: style(layer.rule),
        header: decoration(layer.header, "header")?,
        footer: decoration(layer.footer, "footer")?,
        body,
    };

    let mut fonts_used = vec![("body.font", &config.body.font)];
    let named = [
        ("paragraph.font", &config.paragraph.font),
        ("link.font", &config.link.font),
        ("list.font", &config.list.font),
        ("table.font", &config.table.font),
        ("blockquote.font", &config.blockquote.font),
        ("inline_code.font", &config.inline_code.font),
        ("code.font", &config.code.style.font),
        ("diagram.font", &config.diagram.chart.style.font),
        ("image.font", &config.image.font),
        ("footnotes.font", &config.footnotes.font),
        ("rule.font", &config.rule.font),
        ("header.font", &config.header.font),
        ("footer.font", &config.footer.font),
    ];
    fonts_used.extend(named);
    for heading in &config.headings {
        fonts_used.push(("headings.font", &heading.font));
    }
    for chart in config.diagram.charts.values() {
        fonts_used.push(("diagram.charts.font", &chart.style.font));
    }
    for (field, alias) in fonts_used {
        if alias != "sans" && alias != "mono" && !config.fonts.contains_key(alias.as_str()) {
            return Err(format!("{field}: undeclared font alias {alias:?}"));
        }
    }
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn defaults() -> toml::Table {
        toml::from_str(DEFAULTS).unwrap()
    }

    fn resolve_with(extra: &str) -> std::result::Result<Config, String> {
        let mut table = defaults();
        let layer: toml::Table = toml::from_str(extra).map_err(|e| e.to_string())?;
        let _: Layer = toml::from_str(extra).map_err(|e| e.message().to_owned())?;
        merge(&mut table, layer);
        let layer: Layer = toml::Value::Table(table).try_into().map_err(|e: toml::de::Error| e.to_string())?;
        resolve(layer)
    }

    #[test]
    fn defaults_resolve() {
        let config = resolve_with("").unwrap();
        assert_eq!(config.body.font, "sans");
        assert!((config.page.width.0 - 595.2756).abs() < 0.01);
        assert_eq!(config.headings[0].font_weight, 600);
        assert_eq!(config.paragraph.font_size, config.body.font_size);
        assert!(config.diagram.packages.contains_key("chronos"));
        assert!(config.macros.contains_key("center"));
    }

    #[test]
    fn lengths_and_colors_validate() {
        assert_eq!(Length::parse("96px", false, true).unwrap(), Length(72.0));
        assert!(Length::parse("0", false, true).is_err());
        assert!(Length::parse("10px", false, false).is_err());
        assert!(Length::parse("1.2.3pt", true, true).is_err());
        assert!(resolve_with("[body]\ncolor = \"red\"").is_err());
        assert_eq!(resolve_with("[body]\ncolor = \"#abc\"").unwrap().body.color, Color::Rgb(0xaa, 0xbb, 0xcc));
    }

    #[test]
    fn unknown_keys_are_rejected() {
        assert!(resolve_with("[paragraph]\nunderline = true").unwrap_err().contains("unknown field"));
        assert!(resolve_with("[mermaid]\ntheme = \"neutral\"").is_err());
    }

    #[test]
    fn inheritance_and_box_defaults() {
        let config = resolve_with("[body]\nfont_size = \"12pt\"\n[paragraph]\npadding = \"2pt\"").unwrap();
        assert_eq!(config.paragraph.font_size, Length(12.0));
        assert_eq!(config.list.padding, Length::ZERO);
        assert_eq!(config.blockquote.border_color, config.body.color);
    }

    #[test]
    fn chart_overrides_inherit_diagram_settings() {
        let config =
            resolve_with("[diagram]\nfont_size = \"9pt\"\nwidth = \"50mm\"\n[diagram.charts.2]\ncolor = \"#ff0000\"")
                .unwrap();
        let chart = config.diagram.chart(2);
        assert_eq!(chart.style.font_size, Length(9.0));
        assert_eq!(chart.style.color, Color::Rgb(255, 0, 0));
        assert!(chart.width.is_some());
        assert!(resolve_with("[diagram.charts.02]\ncolor = \"#ff0000\"").is_err());
    }

    #[test]
    fn page_validation() {
        assert!(resolve_with("[page]\nsize = \"custom\"").unwrap_err().contains("width"));
        assert!(resolve_with("[page]\nwidth = \"100mm\"").is_err());
        assert!(
            resolve_with("[page.margins]\nleft = \"110mm\"\nright = \"110mm\"")
                .unwrap_err()
                .contains("printable width")
        );
        let landscape = resolve_with("[page]\norientation = \"landscape\"").unwrap();
        assert!(landscape.page.width.0 > landscape.page.height.0);
    }

    #[test]
    fn fonts_must_be_declared() {
        assert!(resolve_with("[body]\nfont = \"serif\"").unwrap_err().contains("undeclared"));
        assert!(resolve_with("[fonts]\nsans = \"/x.ttf\"").is_err());
    }

    #[test]
    fn decoration_tokens() {
        assert!(DecorationText::parse("{{page}} of {{pages}}").is_ok());
        assert_eq!(DecorationText::parse("{{{{x}}}}").unwrap().0, vec![DecorationPart::Text("{{x}}".into())]);
        assert!(DecorationText::parse("{{date}}").is_err());
        assert!(DecorationText::parse("{{page").is_err());
        assert!(resolve_with("[footer]\nlogo = true").is_err());
        assert!(resolve_with("[header]\nlogo = { position = \"left\" }").unwrap_err().contains("path"));
    }

    #[test]
    fn format_macros() {
        assert!(resolve_with("[macro.empty]").unwrap_err().contains("at least one"));
        assert!(resolve_with("[macro.9x]\ntext_align = \"left\"").is_err());
        assert!(resolve_with("[macro.box]\nwidth = \"0mm\"").is_err());
    }

    #[test]
    fn frontmatter_split() {
        let (body, lines, toml) = split_frontmatter("+++\n[body]\n+++\n# Hi\n").unwrap();
        assert_eq!((body, lines, toml), ("# Hi\n", 3, Some("[body]\n")));
        assert!(split_frontmatter("+++\n[body]\n").is_err());
        assert_eq!(split_frontmatter("text +++\n").unwrap().2, None);
    }

    #[test]
    fn url_schemes() {
        assert!(has_url_scheme("https://x"));
        assert!(!has_url_scheme("C:/fonts/a.ttf"));
        assert!(!has_url_scheme("fonts/a.ttf"));
    }
}
