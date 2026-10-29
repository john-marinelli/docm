//! The generated `/config.typ` (resolved theme as a Typst dictionary) and the
//! main document preamble.

use std::collections::BTreeMap;
use std::fmt::Write;

use crate::config::{Chart, Config, Decoration, DecorationPart, Length, Style};
use crate::markdown::{markup, string};
use crate::world::{MATH_FAMILY, MONO_FAMILY, SANS_FAMILY};

/// The helper library imported by every generated document.
pub const LIBRARY: &str = include_str!("docm.typ");

/// The mitex release whose WASM converter and `mitex-scope` turn LaTeX math
/// into Typst. Its version must be vendored (see scripts/vendor-typst-packages.sh).
pub const MITEX: &str = "@preview/mitex:0.2.7";

/// Font alias → Typst family name.
pub struct Families(pub BTreeMap<String, String>);

impl Families {
    pub fn new(user: BTreeMap<String, String>) -> Self {
        let mut families = user;
        families.insert("sans".into(), SANS_FAMILY.into());
        families.insert("mono".into(), MONO_FAMILY.into());
        Families(families)
    }

    fn get(&self, alias: &str) -> &str {
        self.0.get(alias).map_or(SANS_FAMILY, String::as_str)
    }
}

fn style(style: &Style, families: &Families) -> String {
    // Text edges are set to an em box (0.8em above, 0.2em below the
    // baseline), so CSS-like line-height maps to leading directly.
    let leading = Length(((style.line_height - 1.0) * style.font_size.pt()).max(0.0));
    format!(
        "(font: {}, size: {}, weight: {}, style: {}, align: {}, leading: {leading}, color: {}, background: {}, \
         above: {}, below: {}, inset: {}, stroke-color: {}, stroke-width: {}, radius: {})",
        string(families.get(&style.font)),
        style.font_size,
        style.font_weight,
        string(if style.italic { "italic" } else { "normal" }),
        string(style.text_align.name()),
        style.color.text(),
        style.background.paint(),
        style.space_before,
        style.space_after,
        style.padding,
        style.border_color.paint(),
        style.border_width,
        style.border_radius,
    )
}

fn chart(chart: &Chart, families: &Families) -> String {
    let length = |value: Option<Length>| value.map_or("none".into(), |l| l.to_string());
    format!(
        "(style: {}, width: {}, height: {})",
        style(&chart.style, families),
        length(chart.width),
        length(chart.height)
    )
}

fn decoration_style(decoration: &Decoration, families: &Families) -> String {
    let leading = Length(((decoration.line_height - 1.0) * decoration.font_size.pt()).max(0.0));
    format!(
        "(font: {}, size: {}, weight: {}, style: {}, color: {}, leading: {leading})",
        string(families.get(&decoration.font)),
        decoration.font_size,
        decoration.font_weight,
        string(if decoration.italic { "italic" } else { "normal" }),
        decoration.color.text(),
    )
}

/// `/config.typ`.
pub fn config_source(config: &Config, families: &Families, title: &str, code_theme: Option<&str>) -> String {
    let page = &config.page;
    let content_height = Length(page.height.pt() - page.margin_top.pt() - page.margin_bottom.pt());
    let mut out = String::from("#let cfg = (\n");
    let mut field = |name: &str, value: String| {
        let _ = writeln!(out, "  {name}: {value},");
    };
    field("title", string(title));
    field("page-width", page.width.to_string());
    field("page-height", page.height.to_string());
    field(
        "margins",
        format!(
            "(top: {}, bottom: {}, left: {}, right: {})",
            page.margin_top, page.margin_bottom, page.margin_left, page.margin_right
        ),
    );
    field("content-height", content_height.to_string());
    field("number-headings", config.number_headings.to_string());
    field("body", style(&config.body, families));
    field(
        "headings",
        format!("({},)", config.headings.iter().map(|h| style(h, families)).collect::<Vec<_>>().join(", ")),
    );
    field("paragraph", style(&config.paragraph, families));
    field("link", style(&config.link, families));
    field("link-underline", config.link_underline.to_string());
    field("list", style(&config.list, families));
    field("list-indent", config.list_indent.to_string());
    field("table", style(&config.table, families));
    field("table-header-background", config.table_header_background.paint());
    field("table-stripe-background", config.table_stripe_background.paint());
    field("blockquote", style(&config.blockquote, families));
    field("inline-code", style(&config.inline_code, families));
    field("code", style(&config.code.style, families));
    field("code-line-numbers", config.code.line_numbers.to_string());
    field(
        "code-theme",
        match (&config.code.theme, code_theme) {
            (crate::config::CodeTheme::None, _) => "none".into(),
            (_, Some(path)) => string(path),
            _ => "auto".into(),
        },
    );
    field(
        "math",
        format!(
            "(font: {}, size: {}, color: {}, above: {}, below: {})",
            string(MATH_FAMILY),
            config.math.font_size,
            config.math.color.text(),
            config.math.space_before,
            config.math.space_after
        ),
    );
    field("diagram", chart(&config.diagram.chart, families));
    field(
        "charts",
        format!(
            "({})",
            if config.diagram.charts.is_empty() {
                ":".to_owned()
            } else {
                config
                    .diagram
                    .charts
                    .iter()
                    .map(|(number, c)| format!("{}: {}", string(&number.to_string()), chart(c, families)))
                    .collect::<Vec<_>>()
                    .join(", ")
            }
        ),
    );
    field("image", style(&config.image, families));
    field("image-align", string(config.image_align.name()));
    field("footnotes", style(&config.footnotes, families));
    field("rule", style(&config.rule, families));
    field("header", decoration_style(&config.header, families));
    field("footer", decoration_style(&config.footer, families));
    out.push_str(")\n");
    out
}

fn slot(parts: &crate::config::DecorationText, filename: &str, title: &str) -> String {
    if parts.0.is_empty() {
        return "none".into();
    }
    let mut out = String::from("[");
    for part in &parts.0 {
        match part {
            DecorationPart::Text(text) => out.push_str(&markup(text)),
            DecorationPart::Filename => out.push_str(&markup(filename)),
            DecorationPart::Title => out.push_str(&markup(title)),
            DecorationPart::Page => out.push_str("#context counter(page).display()"),
            DecorationPart::Pages => out.push_str("#context counter(page).final().first()"),
        }
    }
    out.push(']');
    out
}

fn decoration(name: &str, decoration: &Decoration, logo: Option<&str>, filename: &str, title: &str) -> String {
    if decoration.is_empty() {
        return "none".into();
    }
    let logo = match (&decoration.logo, logo) {
        (Some(settings), Some(path)) => format!(
            "(path: {}, position: {}, width: {}, height: {})",
            string(path),
            string(settings.position.name()),
            settings.width,
            settings.height
        ),
        _ => "none".into(),
    };
    format!(
        "decoration-row(cfg.{name}, (left: {}, center: {}, right: {}), {logo})",
        slot(&decoration.left, filename, title),
        slot(&decoration.center, filename, title),
        slot(&decoration.right, filename, title),
    )
}

pub struct Logos<'a> {
    pub header: Option<&'a str>,
    pub footer: Option<&'a str>,
}

/// Imports and the document show rule, placed before the converted body.
pub fn preamble(config: &Config, logos: Logos, filename: &str, title: &str) -> String {
    format!(
        "#import \"/docm.typ\": *\n#import \"{MITEX}\": mi, mimath\n#show: docm-document.with(\n  header: {},\n  footer: {},\n)\n",
        decoration("header", &config.header, logos.header, filename, title),
        decoration("footer", &config.footer, logos.footer, filename, title),
    )
}
