use std::fs;
use std::path::{Path, PathBuf};

use docm::config::ConfigSources;
use docm::error::RenderError;
use docm::render::{Rendered, render};

/// Sources isolated from the user's global theme.
fn sources(dir: &Path) -> ConfigSources {
    ConfigSources { cwd: dir.to_path_buf(), global_theme: dir.join("no-global-theme.toml"), explicit: None }
}

fn write(dir: &Path, name: &str, text: &str) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, text).unwrap();
    path
}

fn ok(markdown: &str) -> Rendered {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "doc.md", markdown);
    render(Path::new("doc.md"), &sources(dir.path())).unwrap_or_else(|error| panic!("{error}"))
}

fn fail(markdown: &str) -> RenderError {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "doc.md", markdown);
    match render(Path::new("doc.md"), &sources(dir.path())) {
        Ok(_) => panic!("expected an error"),
        Err(error) => error,
    }
}

fn line(error: &RenderError) -> usize {
    error.location.as_ref().expect("located error").line
}

#[test]
fn renders_every_feature() {
    let rendered = ok(r#"+++
[document]
toc = true
number_headings = true
+++
# Title

Text with **bold**, _emph_, ~~strike~~, `code`, [link](https://example.com) and # $ * _ [ ] < > @ = - / ' " \ ~.

Inline $\alpha^2$ and display:

$$
\int_0^1 x\,dx
$$

- a
- [x] b
  1. nested

> quote

| a | b |
|---|--:|
| 1 | 2 |

Note[^1].

[^1]: Footnote.

---

```rust
fn main() {}
```

<center>
Centered.
</center>

:::pagebreak

```diagraph
digraph { a -> b }
```

```chronos
_par("A"); _par("B"); _seq("A", "B")
```

```fletcher
node((0,0), [A]), edge("-|>"), node((1,0), [B])
```

```cetz
circle((0,0))
```

```cetz-plot
chart.piechart((1, 2))
```

```timeliney
headerline(group(([Q1], 2)))
taskgroup(title: [Work], { task("A", (0, 1)) })
```

```typst
#rect[raw *Typst*]
```
"#);
    assert!(rendered.pdf.starts_with(b"%PDF-"));
    assert_eq!(rendered.document.pages().len(), 2, "the page break starts a second page");
}

#[test]
fn errors_point_at_markdown_lines() {
    assert_eq!(line(&fail("# T\n\nok\n\nx $\\nosuchcommand$ y\n")), 5);
    let chronos = fail("# T\n\n```chronos\n_par(\"A\")\n_seq(\"A\", \"B\", bogus: 1)\n```\n");
    assert_eq!(line(&chronos), 5);
    assert!(chronos.message.contains("bogus"));
    assert_eq!(line(&fail("```typst\nfine\n\n#nosuchfn()\n```\n")), 4);
    let diagraph = fail("text\n\n```diagraph\ndigraph { a -> }\n```\n");
    assert_eq!(line(&diagraph), 3);
    assert!(diagraph.message.contains("diagraph"));
    // Frontmatter lines count toward Markdown line numbers.
    assert_eq!(line(&fail("+++\n[document]\ntoc = false\n+++\n\n<center>\n")), 6);
}

#[test]
fn configuration_errors_point_at_toml() {
    let error = fail("+++\n[body]\ncolor = \"red\"\n+++\n");
    assert_eq!(line(&error), 3);
    assert!(error.message.contains("#RGB"));
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "doc.md", "# x");
    write(dir.path(), "theme.toml", "[page]\nsize = \"A4\"\nbogus = 1\n");
    let error = render(Path::new("doc.md"), &sources(dir.path())).err().unwrap();
    assert!(error.to_string().contains("theme.toml:3"));
    assert!(error.dependencies.iter().any(|path| path.ends_with("theme.toml")));
}

#[test]
fn layers_merge_in_order() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "global.toml", "[page]\nsize = \"Letter\"\norientation = \"landscape\"\n");
    write(dir.path(), "theme.toml", "[page]\nsize = \"A5\"\n");
    write(dir.path(), "doc.md", "+++\n[page]\norientation = \"portrait\"\n+++\n# x\n");
    let mut sources = sources(dir.path());
    sources.global_theme = dir.path().join("global.toml");
    let rendered = render(Path::new("doc.md"), &sources).unwrap();
    let page = &rendered.document.pages()[0];
    // A5 portrait: 148 × 210 mm.
    assert!((page.frame.width().to_pt() - 148.0 * 72.0 / 25.4).abs() < 0.5);
    assert!((page.frame.height().to_pt() - 210.0 * 72.0 / 25.4).abs() < 0.5);
}

#[test]
fn typst_blocks_are_sandboxed() {
    let error = fail("```typst\n#read(\"/etc/passwd\")\n```\n");
    assert_eq!(line(&error), 2);
    let error = fail("```typst\n#import \"@preview/not-bundled:1.0.0\"\n```\n");
    assert!(error.message.contains("not bundled") || error.message.contains("not found"), "{}", error.message);
}

#[test]
fn custom_diagram_packages_and_chart_overrides() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "theme.toml",
        "[diagram.packages.circles]\nimports = [\"@preview/cetz:0.5.3\"]\nwrap = \"cetz.canvas({ import cetz.draw: *\\n{{body}} })\"\n\n[diagram.charts.1]\nwidth = \"20mm\"\n",
    );
    write(dir.path(), "doc.md", "```circles\ncircle((0,0))\n```\n");
    render(Path::new("doc.md"), &sources(dir.path())).unwrap();

    let error = fail(
        "+++\n[diagram.packages.x]\nimports = [\"@preview/nope:0.1.0\"]\nwrap = \"{{body}}\"\n+++\n```x\n1\n```\n",
    );
    assert!(error.message.contains("not bundled"));
}

#[test]
fn images_and_dependencies() {
    let dir = tempfile::tempdir().unwrap();
    // 1×1 PNG.
    let png = [
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1,
        8, 6, 0, 0, 0, 0x1F, 0x15, 0xC4, 0x89, 0, 0, 0, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0xF8, 0xCF,
        0xC0, 0xF0, 0x1F, 0, 0x05, 0x00, 0x01, 0xFF, 0x89, 0x99, 0x3D, 0x1D, 0, 0, 0, 0, 0x49, 0x45, 0x4E, 0x44, 0xAE,
        0x42, 0x60, 0x82,
    ];
    fs::write(dir.path().join("dot image.png"), png).unwrap();
    write(dir.path(), "doc.md", "![dot](dot%20image.png)\n");
    let rendered = render(Path::new("doc.md"), &sources(dir.path())).unwrap_or_else(|e| panic!("{e}"));
    assert!(rendered.dependencies.iter().any(|path| path.ends_with("dot image.png")));
    assert!(
        rendered.dependencies.iter().any(|path| path.ends_with("theme.toml")),
        "missing optional themes are watched"
    );

    write(dir.path(), "doc.md", "![x](missing.png)\n");
    let error = render(Path::new("doc.md"), &sources(dir.path())).err().unwrap();
    assert!(error.dependencies.iter().any(|path| path.ends_with("missing.png")), "missing images are watched");
}

#[test]
fn header_overflow_reports_margin() {
    let error = fail(
        "+++\n[page.margins]\ntop = \"4mm\"\n[header]\ncenter = \"A long header\"\nfont_size = \"30pt\"\n+++\n# x\n",
    );
    assert!(error.message.contains("page.margins.top"), "{}", error.message);
}

#[test]
fn macro_height_overflow_is_an_error() {
    let error = fail("+++\n[macro.tiny]\nheight = \"5mm\"\n+++\n<tiny>\nOne\n\nTwo\n\nThree\n</tiny>\n");
    assert!(error.message.contains("macro height"), "{}", error.message);
}

#[test]
fn floats_render_beside_following_prose() {
    let rendered = ok(
        "+++\n[macro.aside]\nfloat = \"right\"\nwidth = \"40mm\"\n+++\n<aside>\nSide note.\n</aside>\n\nProse beside it.\n\n# Next\n",
    );
    assert_eq!(rendered.document.pages().len(), 1);
}

#[test]
fn warnings_are_located_and_non_fatal() {
    let rendered = ok("# T\n\n```mermaid\nflowchart LR\n```\n\n```typst\n#text(font: \"NoSuchFont\")[x]\n```\n");
    let lines: Vec<usize> = rendered.warnings.iter().map(line).collect();
    assert_eq!(lines, vec![3, 8], "{:?}", rendered.warnings);
    assert!(rendered.warnings[0].message.contains("Mermaid"));
    assert!(rendered.warnings[1].message.contains("unknown font family"));
    assert!(ok("```diagraph\ndigraph { a -> b }\n```\n").warnings.is_empty());
}
