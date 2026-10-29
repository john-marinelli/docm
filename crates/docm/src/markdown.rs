//! Markdown → Typst markup.
//!
//! comrak parses CommonMark + GFM (tables, task lists, strikethrough,
//! footnotes, autolinks) and `$`/`$$` math. The tree is emitted as calls into
//! `docm.typ`; text is escaped, so no Typst syntax leaks out of Markdown except
//! inside ```` ```typst ```` blocks and diagram fences.
//!
//! Formatting-macro tags (`<center>`…`</center>`) and `:::pagebreak` are not
//! Markdown, so a pre-pass rewrites them (outside code and math) into tokens
//! comrak keeps intact: a standalone tag line becomes an HTML comment block,
//! which can interrupt paragraphs and ends on its own line, and a tag inside a
//! line becomes a private-use sentinel in the text. Line numbers are preserved.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use comrak::nodes::{AstNode, ListType, NodeValue, TableAlignment};
use comrak::{Arena, Options, parse_document};

use crate::config::{Config, Float, Slot, has_url_scheme};
use crate::error::{Location, RenderError, Result};
use crate::world::package_available;

type Node<'a> = &'a AstNode<'a>;

const SENTINEL_OPEN: char = '\u{E000}';
const SENTINEL_CLOSE: char = '\u{E001}';
const COMMENT_PREFIX: &str = "<!--\u{E000}docm:";

/// A Typst output position and the Markdown line it came from. `verbatim`
/// entries copy Markdown lines one-to-one, so later lines map exactly.
#[derive(Debug, Clone, Copy)]
pub struct MapEntry {
    pub offset: usize,
    pub line: usize,
    pub column: usize,
    pub verbatim: bool,
}

#[derive(Debug, Default)]
pub struct Converted {
    /// The document body (Typst markup), without the preamble.
    pub body: String,
    pub map: Vec<MapEntry>,
    /// Virtual path → bytes, for the Typst world.
    pub assets: Vec<(String, Vec<u8>)>,
    /// Images read (or probed) while converting.
    pub dependencies: Vec<PathBuf>,
    /// First level-one heading's plain text, if any.
    pub title: Option<String>,
    /// Each diagram fence: its name, imported package specs, and location.
    /// Errors raised during layout inside a package have no span in the
    /// document; these let them point at the right fence.
    pub fences: Vec<Fence>,
    /// Non-fatal problems, such as leftover Mermaid fences.
    pub warnings: Vec<RenderError>,
}

#[derive(Debug, Clone)]
pub struct Fence {
    pub name: String,
    pub packages: Vec<String>,
    pub location: Location,
}

fn options() -> Options<'static> {
    let mut options = Options::default();
    options.extension.strikethrough = true;
    options.extension.table = true;
    options.extension.autolink = true;
    options.extension.tasklist = true;
    options.extension.footnotes = true;
    options.extension.math_dollars = true;
    options
}

// ---------------------------------------------------------------------------
// Escaping

/// Escape text for Typst markup. Every ASCII punctuation character is
/// escaped: that disables markup syntax, smart quotes, dashes, URL
/// detection and expression continuation after an embedded `#call[...]`.
pub fn markup(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    for c in text.chars() {
        match c {
            '\t' | '\n' | '\r' => out.push(' '),
            c if c.is_ascii_punctuation() => {
                out.push('\\');
                out.push(c);
            }
            c => out.push(c),
        }
    }
    out
}

/// A Typst string literal.
pub fn string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn opt_string(value: Option<&str>) -> String {
    value.map_or_else(|| "none".to_owned(), string)
}

// ---------------------------------------------------------------------------
// Pre-pass: formatting macros and page breaks

fn line_starts(text: &str) -> Vec<usize> {
    std::iter::once(0).chain(text.match_indices('\n').map(|(i, _)| i + 1)).collect()
}

/// Byte ranges owned by code and math, where tags stay literal.
fn protected_ranges(text: &str) -> Vec<(usize, usize)> {
    let arena = Arena::new();
    let root = parse_document(&arena, text, &options());
    let starts = line_starts(text);
    let offset = |line: usize, column: usize| -> usize {
        let start = starts.get(line.saturating_sub(1)).copied().unwrap_or(text.len());
        (start + column.saturating_sub(1)).min(text.len())
    };
    let mut ranges = Vec::new();
    for node in root.descendants() {
        let ast = node.data.borrow();
        let protected = matches!(ast.value, NodeValue::CodeBlock(_) | NodeValue::Code(_) | NodeValue::Math(_));
        if protected {
            let pos = ast.sourcepos;
            // End positions are inclusive; protect through the whole end line
            // for blocks so closing fences are covered too.
            let end = if matches!(ast.value, NodeValue::CodeBlock(_)) {
                starts.get(pos.end.line).copied().unwrap_or(text.len())
            } else {
                offset(pos.end.line, pos.end.column) + 1
            };
            ranges.push((offset(pos.start.line, pos.start.column), end));
        }
    }
    ranges
}

fn is_macro_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Parse `<name>` / `</name>` at the start of `text`: (closing, name, length).
fn tag_at<'t>(text: &'t str, macros: &HashSet<&str>) -> Option<(bool, &'t str, usize)> {
    let rest = text.strip_prefix('<')?;
    let (closing, rest) = match rest.strip_prefix('/') {
        Some(rest) => (true, rest),
        None => (false, rest),
    };
    let end = rest.find('>')?;
    let name = &rest[..end];
    (is_macro_name(name) && macros.contains(name)).then(|| (closing, name, end + 2 + usize::from(closing)))
}

pub fn preprocess(text: &str, config: &Config) -> String {
    let macros: HashSet<&str> = config.macros.keys().map(String::as_str).collect();
    if macros.is_empty() && !text.contains(":::pagebreak") {
        return text.to_owned();
    }
    let protected = protected_ranges(text);
    let is_protected = |offset: usize| protected.iter().any(|&(start, end)| offset >= start && offset < end);
    let mut out = String::with_capacity(text.len() + 64);
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        let content = line.trim_end_matches(['\n', '\r']);
        let ending = &line[content.len()..];
        // Container prefix: indentation and block-quote markers.
        let prefix_len = content.len() - content.trim_start_matches([' ', '\t', '>']).len();
        let (prefix, rest) = content.split_at(prefix_len);
        let trimmed = rest.trim_end_matches([' ', '\t']);
        let marker_offset = offset + prefix_len;
        let standalone = if is_protected(marker_offset) {
            None
        } else if trimmed == ":::pagebreak"
            && prefix.chars().filter(|c| *c == ' ').count() <= 3 + prefix.matches('>').count()
        {
            Some("pagebreak".to_owned())
        } else {
            tag_at(trimmed, &macros)
                .filter(|(_, _, len)| *len == trimmed.len())
                .map(|(closing, name, _)| format!("{}:{name}", if closing { "close" } else { "open" }))
        };
        if let Some(directive) = standalone {
            out.push_str(prefix);
            out.push_str(COMMENT_PREFIX);
            out.push_str(&directive);
            out.push_str("-->");
            out.push_str(ending);
        } else if macros.is_empty() {
            out.push_str(line);
        } else {
            // Inline tags become sentinels; escaped tags (`\<x>`) stay literal.
            let mut index = 0;
            let bytes = content.as_bytes();
            while index < content.len() {
                let c = content[index..].chars().next().unwrap();
                if c == '<' && !is_protected(offset + index) {
                    let backslashes = bytes[..index].iter().rev().take_while(|b| **b == b'\\').count();
                    if backslashes % 2 == 0
                        && let Some((closing, name, len)) = tag_at(&content[index..], &macros)
                    {
                        out.push(SENTINEL_OPEN);
                        out.push(if closing { 'c' } else { 'o' });
                        out.push_str(name);
                        out.push(SENTINEL_CLOSE);
                        index += len;
                        continue;
                    }
                }
                out.push(c);
                index += c.len_utf8();
            }
            out.push_str(ending);
        }
        offset += line.len();
    }
    out
}

// ---------------------------------------------------------------------------
// Block structure with macros

#[derive(Debug, Clone)]
enum Inline<'a> {
    Node(Node<'a>),
    Text(String),
}

enum Piece<'a> {
    Block(Node<'a>),
    /// A paragraph fragment split around macro tags.
    Para(Vec<Inline<'a>>, Location),
    Open(String, Location),
    Close(String, Location),
    Pagebreak(Location),
}

enum Tree<'a> {
    Block(Node<'a>),
    Para(Vec<Inline<'a>>, Location),
    Pagebreak(Location),
    Macro(String, Location, Vec<Tree<'a>>),
}

/// Split inline text at sentinels: `(text, Some((closing, name)))` pairs.
fn split_sentinels(text: &str) -> Vec<(String, Option<(bool, String)>)> {
    let mut parts = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find(SENTINEL_OPEN) {
        let after = &rest[start + SENTINEL_OPEN.len_utf8()..];
        let Some(end) = after.find(SENTINEL_CLOSE) else { break };
        let token = &after[..end];
        let closing = token.starts_with('c');
        parts.push((rest[..start].to_owned(), Some((closing, token[1..].to_owned()))));
        rest = &after[end + SENTINEL_CLOSE.len_utf8()..];
    }
    parts.push((rest.to_owned(), None));
    parts
}

/// Restore literal tags for sentinels that are not acting as macros (for
/// example inside emphasis or link text).
fn restore_sentinels(text: &str) -> String {
    split_sentinels(text)
        .into_iter()
        .map(|(text, tag)| match tag {
            Some((closing, name)) => format!("{text}<{}{name}>", if closing { "/" } else { "" }),
            None => text,
        })
        .collect()
}

fn is_blank_inline(inline: &Inline) -> bool {
    match inline {
        Inline::Text(text) => text.trim().is_empty(),
        Inline::Node(node) => matches!(node.data.borrow().value, NodeValue::SoftBreak | NodeValue::LineBreak),
    }
}

fn trim_inlines<'a>(mut items: Vec<Inline<'a>>) -> Vec<Inline<'a>> {
    while items.first().is_some_and(is_blank_inline) {
        items.remove(0);
    }
    while items.last().is_some_and(is_blank_inline) {
        items.pop();
    }
    items
}

// ---------------------------------------------------------------------------
// Converter

#[derive(Clone, Copy)]
struct Ctx<'s> {
    /// Formatting-macro alignment override.
    al: Option<&'s str>,
    /// Inside a Typst container (list, quote, layout macro, cell…), where
    /// page breaks are impossible.
    container: bool,
    /// Directly inside a tight list item: paragraphs are bare inline content.
    tight: bool,
}

pub struct Converter<'c> {
    config: &'c Config,
    source_path: PathBuf,
    base_dir: PathBuf,
    line_offset: usize,
    out: String,
    map: Vec<MapEntry>,
    assets: Vec<(String, Vec<u8>)>,
    asset_paths: HashMap<PathBuf, String>,
    dependencies: Vec<PathBuf>,
    slugs: Vec<String>,
    next_slug: usize,
    known_slugs: HashSet<String>,
    footnotes: HashMap<String, Node<'c>>,
    footnotes_emitted: HashSet<String>,
    diagrams: usize,
    fences: Vec<Fence>,
    warnings: Vec<RenderError>,
    title: Option<String>,
    pending_pagebreak: bool,
    seen_block: bool,
}

pub fn convert(markdown: &str, source_path: &Path, line_offset: usize, config: &Config) -> Result<Converted> {
    let text = preprocess(markdown, config);
    let arena = Arena::new();
    let root = parse_document(&arena, &text, &options());
    let mut converter = Converter {
        config,
        source_path: source_path.to_path_buf(),
        base_dir: source_path.parent().unwrap_or(Path::new("/")).to_path_buf(),
        line_offset,
        out: String::new(),
        map: Vec::new(),
        assets: Vec::new(),
        asset_paths: HashMap::new(),
        dependencies: Vec::new(),
        slugs: Vec::new(),
        next_slug: 0,
        known_slugs: HashSet::new(),
        footnotes: HashMap::new(),
        footnotes_emitted: HashSet::new(),
        diagrams: 0,
        fences: Vec::new(),
        warnings: Vec::new(),
        title: None,
        pending_pagebreak: false,
        seen_block: false,
    };
    converter.collect(root);
    if config.toc && !converter.slugs.is_empty() {
        converter.out.push_str("#docm-toc()\n");
    }
    let result = converter.children(root, Ctx { al: None, container: false, tight: false });
    let dependencies = std::mem::take(&mut converter.dependencies);
    result.map_err(|error| error.with_dependencies(dependencies.iter().cloned()))?;
    Ok(Converted {
        body: converter.out,
        map: converter.map,
        assets: converter.assets,
        dependencies,
        title: converter.title,
        fences: converter.fences,
        warnings: converter.warnings,
    })
}

impl<'c> Converter<'c> {
    fn location(&self, node: Node) -> Location {
        let pos = node.data.borrow().sourcepos;
        Location::new(&self.source_path, pos.start.line + self.line_offset, pos.start.column)
    }

    fn mark(&mut self, location: &Location) {
        self.map.push(MapEntry {
            offset: self.out.len(),
            line: location.line,
            column: location.column,
            verbatim: false,
        });
    }

    fn mark_verbatim(&mut self, line: usize) {
        self.map.push(MapEntry { offset: self.out.len(), line, column: 1, verbatim: true });
    }

    fn error(&self, message: impl Into<String>, location: Location) -> RenderError {
        RenderError::at(message, location)
    }

    /// Headings (slugs, title) and footnote definitions, before emission, so
    /// links and references can point forward.
    fn collect(&mut self, root: Node<'c>) {
        let mut counts: HashMap<String, usize> = HashMap::new();
        for node in root.descendants() {
            let value = &node.data.borrow().value;
            match value {
                NodeValue::Heading(heading) => {
                    let text = restore_sentinels(&plain_text(node));
                    let text = strip_tags(&text);
                    if heading.level == 1 && self.title.is_none() {
                        self.title = Some(text.trim().to_owned());
                    }
                    let base = slugify(&text);
                    let mut slug = base.clone();
                    let count = counts.entry(base.clone()).or_insert(0);
                    while self.known_slugs.contains(&slug) {
                        *count += 1;
                        slug = format!("{base}-{count}");
                    }
                    self.known_slugs.insert(slug.clone());
                    self.slugs.push(slug);
                }
                NodeValue::FootnoteDefinition(definition) => {
                    self.footnotes.entry(definition.name.clone()).or_insert(node);
                }
                _ => {}
            }
        }
    }

    // -- containers ---------------------------------------------------------

    fn children(&mut self, parent: Node<'c>, ctx: Ctx) -> Result<()> {
        let pieces = self.pieces(parent)?;
        let trees = self.group(pieces)?;
        self.trees(trees, ctx)
    }

    fn pieces(&self, parent: Node<'c>) -> Result<Vec<Piece<'c>>> {
        let mut pieces = Vec::new();
        for child in parent.children() {
            let ast = child.data.borrow();
            match &ast.value {
                NodeValue::HtmlBlock(html) if html.literal.starts_with(COMMENT_PREFIX) => {
                    let directive = html.literal[COMMENT_PREFIX.len()..].trim_end().trim_end_matches("-->");
                    let location = self.location(child);
                    if directive == "pagebreak" {
                        pieces.push(Piece::Pagebreak(location));
                    } else if let Some(name) = directive.strip_prefix("open:") {
                        pieces.push(Piece::Open(name.to_owned(), location));
                    } else if let Some(name) = directive.strip_prefix("close:") {
                        pieces.push(Piece::Close(name.to_owned(), location));
                    }
                }
                NodeValue::Paragraph if has_sentinel(child) => {
                    let base = self.location(child);
                    let mut fragment = Vec::new();
                    for inline in child.children() {
                        let text = match &inline.data.borrow().value {
                            NodeValue::Text(text) => Some(text.to_string()),
                            _ => None,
                        };
                        let Some(text) = text else {
                            fragment.push(Inline::Node(inline));
                            continue;
                        };
                        let location = self.location(inline);
                        for (text, tag) in split_sentinels(&text) {
                            if !text.is_empty() {
                                fragment.push(Inline::Text(text));
                            }
                            if let Some((closing, name)) = tag {
                                let items = trim_inlines(std::mem::take(&mut fragment));
                                if !items.is_empty() {
                                    pieces.push(Piece::Para(items, base.clone()));
                                }
                                pieces.push(if closing {
                                    Piece::Close(name, location.clone())
                                } else {
                                    Piece::Open(name, location.clone())
                                });
                            }
                        }
                    }
                    let items = trim_inlines(fragment);
                    if !items.is_empty() {
                        pieces.push(Piece::Para(items, base));
                    }
                }
                _ => pieces.push(Piece::Block(child)),
            }
        }
        Ok(pieces)
    }

    fn group(&self, pieces: Vec<Piece<'c>>) -> Result<Vec<Tree<'c>>> {
        let mut stack: Vec<(String, Location, Vec<Tree<'c>>)> = Vec::new();
        let mut output = Vec::new();
        for piece in pieces {
            let tree = match piece {
                Piece::Open(name, location) => {
                    stack.push((name, location, Vec::new()));
                    continue;
                }
                Piece::Close(name, location) => {
                    let Some((open, open_location, children)) = stack.pop() else {
                        return Err(self.error(format!("Unexpected closing macro tag </{name}>"), location));
                    };
                    if open != name {
                        return Err(self.error(
                            format!("Unexpected closing macro tag </{name}>; <{open}> is still open"),
                            location,
                        ));
                    }
                    Tree::Macro(open, open_location, children)
                }
                Piece::Block(node) => Tree::Block(node),
                Piece::Para(items, location) => Tree::Para(items, location),
                Piece::Pagebreak(location) => Tree::Pagebreak(location),
            };
            match stack.last_mut() {
                Some((_, _, children)) => children.push(tree),
                None => output.push(tree),
            }
        }
        if let Some((name, location, _)) = stack.pop() {
            return Err(self.error(format!("Unclosed macro tag <{name}>"), location));
        }
        Ok(output)
    }

    fn floated(&self, tree: &Tree) -> Option<Float> {
        match tree {
            Tree::Macro(name, ..) => self.config.macros[name].float.filter(|float| *float != Float::None),
            _ => None,
        }
    }

    /// Prose beside a float runs until a heading, rule, page break or float.
    fn ends_float_run(&self, tree: &Tree) -> bool {
        match tree {
            Tree::Pagebreak(_) => true,
            Tree::Block(node) => matches!(node.data.borrow().value, NodeValue::Heading(_) | NodeValue::ThematicBreak),
            tree => self.floated(tree).is_some(),
        }
    }

    fn trees(&mut self, trees: Vec<Tree<'c>>, ctx: Ctx) -> Result<()> {
        let mut iter = trees.into_iter().peekable();
        while let Some(tree) = iter.next() {
            if let Some(side) = self.floated(&tree) {
                let mut rest = Vec::new();
                while let Some(next) = iter.peek() {
                    if self.ends_float_run(next) {
                        break;
                    }
                    rest.push(iter.next().unwrap());
                }
                self.float(tree, side, rest, ctx)?;
            } else {
                self.tree(tree, ctx)?;
            }
        }
        Ok(())
    }

    fn before_block(&mut self) {
        if self.pending_pagebreak && self.seen_block {
            self.out.push_str("#pagebreak(weak: true)\n");
        }
        self.pending_pagebreak = false;
        self.seen_block = true;
    }

    fn tree(&mut self, tree: Tree<'c>, ctx: Ctx) -> Result<()> {
        match tree {
            Tree::Pagebreak(location) => {
                if ctx.container {
                    return Err(self.error(
                        "Page breaks are not supported inside lists, block quotes, tables, footnotes, or layout macros",
                        location,
                    ));
                }
                self.pending_pagebreak = true;
                Ok(())
            }
            Tree::Para(items, location) => {
                self.before_block();
                self.mark(&location);
                self.paragraph(&items, ctx)
            }
            Tree::Block(node) => self.block(node, ctx),
            Tree::Macro(name, location, children) => {
                self.before_block();
                self.mark(&location);
                let definition = &self.config.macros[&name];
                let al = definition.text_align.map(Slot::name);
                let layout = definition.width.is_some() || definition.height.is_some();
                let inner = Ctx { al: al.or(ctx.al), container: ctx.container || layout, tight: false };
                let width = definition.width.map_or("none".into(), |w| w.to_string());
                let height = definition.height.map_or("none".into(), |h| h.to_string());
                self.out.push_str(&format!(
                    "#docm-macro({}, {}, {width}, {height}, [\n",
                    string(&name),
                    opt_string(inner.al)
                ));
                self.trees(children, inner)?;
                self.out.push_str("])\n");
                Ok(())
            }
        }
    }

    fn float(&mut self, tree: Tree<'c>, side: Float, rest: Vec<Tree<'c>>, ctx: Ctx) -> Result<()> {
        let Tree::Macro(name, location, children) = tree else { unreachable!() };
        self.before_block();
        self.mark(&location);
        let definition = &self.config.macros[&name];
        let al = definition.text_align.map(Slot::name);
        let inner = Ctx { al: al.or(ctx.al), container: true, tight: false };
        let width = definition.width.map_or("none".into(), |w| w.to_string());
        let height = definition.height.map_or("none".into(), |h| h.to_string());
        let side = if side == Float::Left { "left" } else { "right" };
        self.out.push_str(&format!(
            "#docm-float({}, {width}, docm-macro({}, {}, none, {height}, [\n",
            string(side),
            string(&name),
            opt_string(inner.al)
        ));
        self.trees(children, inner)?;
        self.out.push_str("]), [\n");
        let saved = self.seen_block;
        self.trees(rest, Ctx { al: ctx.al, container: true, tight: false })?;
        self.seen_block = saved || self.seen_block;
        self.out.push_str("])\n");
        Ok(())
    }

    // -- blocks -------------------------------------------------------------

    fn block(&mut self, node: Node<'c>, ctx: Ctx) -> Result<()> {
        let location = self.location(node);
        let value = node.data.borrow().value.clone();
        if matches!(value, NodeValue::FootnoteDefinition(_)) {
            return Ok(()); // Emitted at the (first) reference.
        }
        self.before_block();
        self.mark(&location);
        match value {
            NodeValue::Paragraph => {
                let items: Vec<Inline> = node.children().map(Inline::Node).collect();
                self.paragraph(&items, ctx)?;
            }
            NodeValue::Heading(heading) => {
                let slug = self.slugs.get(self.next_slug).cloned().unwrap_or_default();
                self.next_slug += 1;
                let (items, al) = self.heading_inlines(node, &location)?;
                let al = al.or(ctx.al);
                self.out.push_str(&format!(
                    "#docm-heading({}, {}, {}, [",
                    heading.level,
                    opt_string(al),
                    string(&slug)
                ));
                self.inlines(&items)?;
                self.out.push_str("])\n");
            }
            NodeValue::BlockQuote | NodeValue::MultilineBlockQuote(_) => {
                self.out.push_str(&format!("#docm-quote({}, [\n", opt_string(ctx.al)));
                self.nested(node, ctx, false)?;
                self.out.push_str("])\n");
            }
            NodeValue::List(list) => {
                let ordered = list.list_type == ListType::Ordered;
                self.out.push_str(&format!(
                    "#docm-list({}, {}, {ordered}, {}, (\n",
                    opt_string(ctx.al),
                    list.tight,
                    list.start
                ));
                for item in node.children() {
                    let checked = match &item.data.borrow().value {
                        NodeValue::TaskItem(task) => Some(task.symbol.is_some()),
                        _ => None,
                    };
                    let location = self.location(item);
                    self.mark(&location);
                    self.out.push('[');
                    if let Some(checked) = checked {
                        self.out.push_str(&format!("#docm-task({checked}, ["));
                    }
                    self.nested(item, ctx, list.tight)?;
                    if checked.is_some() {
                        self.out.push_str("])");
                    }
                    self.out.push_str("],\n");
                }
                self.out.push_str("))\n");
            }
            NodeValue::CodeBlock(code) => {
                let lang = code.info.split_whitespace().next().unwrap_or("").to_owned();
                // The body begins on the line after an opening fence.
                let body_line = location.line + usize::from(code.fenced);
                self.code_block(&lang, &code.literal, body_line, &location, ctx)?;
            }
            NodeValue::HtmlBlock(html) => {
                // Authored HTML is never interpreted; show it literally.
                self.out.push_str(&format!("#docm-par({}, [", opt_string(ctx.al)));
                self.literal_lines(&restore_sentinels(&html.literal));
                self.out.push_str("])\n");
            }
            NodeValue::ThematicBreak => self.out.push_str("#docm-rule()\n"),
            NodeValue::Table(table) => {
                let aligns: Vec<String> = table
                    .alignments
                    .iter()
                    .map(|alignment| {
                        match alignment {
                            TableAlignment::Left => "\"left\"",
                            TableAlignment::Center => "\"center\"",
                            TableAlignment::Right => "\"right\"",
                            TableAlignment::None => "none",
                        }
                        .to_owned()
                    })
                    .collect();
                self.out.push_str(&format!("#docm-table({}, ({},), ", opt_string(ctx.al), aligns.join(", ")));
                let mut rows = node.children();
                self.out.push('(');
                if let Some(header) = rows.next() {
                    self.row(header, table.alignments.len())?;
                }
                self.out.push_str("), (\n");
                for row in rows {
                    self.out.push('(');
                    self.row(row, table.alignments.len())?;
                    self.out.push_str("),\n");
                }
                self.out.push_str("))\n");
            }
            NodeValue::DescriptionList | NodeValue::FrontMatter(_) => {}
            _ => {
                // Unknown block: emit its children as blocks.
                self.nested(node, ctx, false)?;
            }
        }
        Ok(())
    }

    fn nested(&mut self, node: Node<'c>, ctx: Ctx, tight: bool) -> Result<()> {
        let saved = (self.seen_block, self.pending_pagebreak);
        self.seen_block = false;
        let result = self.children(node, Ctx { al: ctx.al, container: true, tight });
        (self.seen_block, self.pending_pagebreak) = saved;
        result
    }

    fn row(&mut self, row: Node<'c>, columns: usize) -> Result<()> {
        let mut count = 0;
        for cell in row.children() {
            self.out.push('[');
            let items: Vec<Inline> = cell.children().map(Inline::Node).collect();
            self.inlines(&items)?;
            self.out.push_str("], ");
            count += 1;
        }
        for _ in count..columns {
            self.out.push_str("[], ");
        }
        Ok(())
    }

    fn literal_lines(&mut self, text: &str) {
        let lines: Vec<&str> = text.trim_end_matches('\n').split('\n').collect();
        for (index, line) in lines.iter().enumerate() {
            if index > 0 {
                self.out.push_str("#linebreak()");
            }
            self.out.push_str(&markup(line));
        }
    }

    fn paragraph(&mut self, items: &[Inline<'c>], ctx: Ctx) -> Result<()> {
        let items = trim_inlines(items.to_vec());
        let is_image = |item: &Inline| matches!(item, Inline::Node(node) if matches!(node.data.borrow().value, NodeValue::Image(_)));
        let is_display_math = |item: &Inline| matches!(item, Inline::Node(node) if matches!(&node.data.borrow().value, NodeValue::Math(math) if math.display_math));
        let significant: Vec<&Inline> = items.iter().filter(|item| !is_blank_inline(item)).collect();
        if !significant.is_empty() && significant.iter().all(|item| is_image(item)) {
            // Standalone images are figures (block-level, fitted to the page).
            for item in significant {
                let Inline::Node(node) = item else { continue };
                let NodeValue::Image(link) = &node.data.borrow().value else { continue };
                let location = self.location(node);
                let path = self.asset(&link.url, &location)?;
                let alt = plain_text(node);
                self.out.push_str(&format!(
                    "#docm-image({}, {}, {})\n",
                    opt_string(ctx.al),
                    string(&path),
                    string(&alt)
                ));
            }
            return Ok(());
        }
        if significant.len() == 1 && is_display_math(significant[0]) {
            let Inline::Node(node) = significant[0] else { unreachable!() };
            return self.inline(node, ctx.al);
        }
        if ctx.tight {
            self.inlines_with(&items, ctx.al)?;
            self.out.push('\n');
            return Ok(());
        }
        self.out.push_str(&format!("#docm-par({}, [", opt_string(ctx.al)));
        self.inlines_with(&items, ctx.al)?;
        self.out.push_str("])\n");
        Ok(())
    }

    fn heading_inlines(&self, node: Node<'c>, location: &Location) -> Result<(Vec<Inline<'c>>, Option<&'static str>)> {
        if !has_sentinel(node) {
            return Ok((node.children().map(Inline::Node).collect(), None));
        }
        let mut items = Vec::new();
        let mut tags = Vec::new();
        for (index, child) in node.children().enumerate() {
            let text = match &child.data.borrow().value {
                NodeValue::Text(text) => Some(text.to_string()),
                _ => None,
            };
            match text {
                Some(text) => {
                    for (text, tag) in split_sentinels(&text) {
                        if !text.is_empty() {
                            items.push(Inline::Text(text));
                        }
                        if let Some(tag) = tag {
                            tags.push((index, items.len(), tag));
                        }
                    }
                }
                None => items.push(Inline::Node(child)),
            }
        }
        let wraps_all = tags.len() == 2
            && !tags[0].2.0
            && tags[1].2.0
            && tags[0].2.1 == tags[1].2.1
            && tags[0].1 == 0
            && tags[1].1 == items.len();
        if !wraps_all {
            return Err(self.error("Macro tags inside a heading must wrap the whole heading", location.clone()));
        }
        let name = &tags[0].2.1;
        let al = self.config.macros[name].text_align.map(Slot::name);
        Ok((trim_inlines(items), al))
    }

    // -- code, diagrams, math --------------------------------------------------

    fn code_block(&mut self, lang: &str, body: &str, body_line: usize, location: &Location, ctx: Ctx) -> Result<()> {
        if lang == "typst" {
            self.out.push_str("#[\n");
            self.mark_verbatim(body_line);
            self.out.push_str(body.trim_end_matches('\n'));
            self.out.push_str("\n]\n");
            return Ok(());
        }
        if lang == "mermaid" && !self.config.diagram.packages.contains_key("mermaid") {
            self.warnings.push(self.error(
                "Mermaid is no longer supported, so this fence renders as code; use ```diagraph (Graphviz DOT) or another diagram fence",
                location.clone(),
            ));
        }
        if lang == "math" {
            return self.display_math(body, location, ctx.al);
        }
        if let Some(package) = self.config.diagram.packages.get(lang) {
            for spec in &package.imports {
                if !package_available(spec) {
                    return Err(self.error(
                        format!("Diagram fence `{lang}` imports {spec}, which is not bundled with docm"),
                        location.clone(),
                    ));
                }
            }
            self.diagrams += 1;
            self.fences.push(Fence {
                name: lang.to_owned(),
                packages: package.imports.clone(),
                location: location.clone(),
            });
            let chart = if self.config.diagram.charts.contains_key(&self.diagrams) {
                format!("cfg.charts.at({})", string(&self.diagrams.to_string()))
            } else {
                "cfg.diagram".to_owned()
            };
            self.out.push_str(&format!("#docm-diagram({chart}, {}, {{\n", opt_string(ctx.al)));
            for spec in &package.imports {
                self.out.push_str(&format!("import {}\n", string(spec)));
            }
            let wrap = package.wrap.clone();
            let mut rest = wrap.as_str();
            while let Some(start) = rest.find("{{") {
                self.out.push_str(&rest[..start]);
                let after = &rest[start..];
                if let Some(after) = after.strip_prefix("{{body}}") {
                    self.mark_verbatim(body_line);
                    self.out.push_str(body.trim_end_matches('\n'));
                    self.mark(location);
                    rest = after;
                } else if let Some(after) = after.strip_prefix("{{body_string}}") {
                    self.out.push_str(&string(body));
                    rest = after;
                } else {
                    self.out.push_str("{{");
                    rest = &after[2..];
                }
            }
            self.out.push_str(rest);
            self.out.push_str("\n})\n");
            return Ok(());
        }
        let lang = if lang.is_empty() { "none".to_owned() } else { string(lang) };
        self.out.push_str(&format!(
            "#docm-code({}, {lang}, {})\n",
            opt_string(ctx.al),
            string(body.strip_suffix('\n').unwrap_or(body))
        ));
        Ok(())
    }

    fn tex(&self, tex: &str, location: &Location) -> Result<String> {
        if tex.trim().is_empty() {
            return Err(self.error("Math expression is empty", location.clone()));
        }
        let mut source = String::new();
        for (name, definition) in &self.config.math.macros {
            if definition.args > 0 {
                source.push_str(&format!("\\newcommand{{\\{name}}}[{}]{{{}}}", definition.args, definition.body));
            } else {
                source.push_str(&format!("\\newcommand{{\\{name}}}{{{}}}", definition.body));
            }
        }
        source.push_str(tex);
        Ok(string(&source))
    }

    fn display_math(&mut self, tex: &str, location: &Location, al: Option<&str>) -> Result<()> {
        let tex = self.tex(tex, location)?;
        self.out.push_str(&format!("#docm-math({}, mimath({tex}))", opt_string(al)));
        Ok(())
    }

    // -- inlines ------------------------------------------------------------

    fn inlines(&mut self, items: &[Inline<'c>]) -> Result<()> {
        self.inlines_with(items, None)
    }

    fn inlines_with(&mut self, items: &[Inline<'c>], al: Option<&str>) -> Result<()> {
        for item in items {
            match item {
                Inline::Text(text) => self.out.push_str(&markup(text)),
                Inline::Node(node) => self.inline(node, al)?,
            }
        }
        Ok(())
    }

    fn inline_children(&mut self, node: Node<'c>) -> Result<()> {
        for child in node.children() {
            self.inline(child, None)?;
        }
        Ok(())
    }

    fn wrap(&mut self, function: &str, node: Node<'c>) -> Result<()> {
        self.out.push_str(&format!("#{function}["));
        self.inline_children(node)?;
        self.out.push(']');
        Ok(())
    }

    fn inline(&mut self, node: Node<'c>, al: Option<&str>) -> Result<()> {
        let value = node.data.borrow().value.clone();
        match value {
            NodeValue::Text(text) => self.out.push_str(&markup(&restore_sentinels(&text))),
            NodeValue::SoftBreak => self.out.push(' '),
            NodeValue::LineBreak => self.out.push_str("#linebreak()"),
            NodeValue::Code(code) => self.out.push_str(&format!("#raw({})", string(&code.literal))),
            NodeValue::Emph => self.wrap("emph", node)?,
            NodeValue::Strong => self.wrap("strong", node)?,
            NodeValue::Strikethrough => self.wrap("strike", node)?,
            NodeValue::Superscript => self.wrap("super", node)?,
            NodeValue::Highlight => self.wrap("highlight", node)?,
            NodeValue::Link(link) => self.link(&link.url, node)?,
            NodeValue::Image(link) => {
                let location = self.location(node);
                let path = self.asset(&link.url, &location)?;
                let alt = plain_text(node);
                self.out.push_str(&format!("#docm-inline-image({}, {})", string(&path), string(&alt)));
            }
            NodeValue::Math(math) => {
                let location = self.location(node);
                self.mark(&location);
                if math.display_math {
                    self.display_math(&math.literal, &location, al)?;
                } else {
                    let tex = self.tex(&math.literal, &location)?;
                    self.out.push_str(&format!("#docm-math-text(mi({tex}))"));
                }
            }
            NodeValue::FootnoteReference(reference) => self.footnote(&reference.name)?,
            NodeValue::HtmlInline(html) => self.out.push_str(&markup(&restore_sentinels(&html))),
            NodeValue::Raw(raw) => self.out.push_str(&markup(&raw)),
            _ => self.inline_children(node)?,
        }
        Ok(())
    }

    fn link(&mut self, url: &str, node: Node<'c>) -> Result<()> {
        let target = if let Some(fragment) = url.strip_prefix('#') {
            let decoded = percent_decode(fragment);
            self.known_slugs.contains(&decoded).then(|| format!("label({})", string(&decoded)))
        } else if has_url_scheme(url) {
            let scheme = url.split(':').next().unwrap_or("").to_ascii_lowercase();
            // Executable or unknown schemes lose their target.
            matches!(scheme.as_str(), "http" | "https" | "mailto").then(|| string(url))
        } else {
            Some(string(url))
        };
        match target {
            Some(target) => {
                self.out.push_str(&format!("#link({target})["));
                self.inline_children(node)?;
                self.out.push(']');
            }
            None => self.inline_children(node)?,
        }
        Ok(())
    }

    fn footnote(&mut self, name: &str) -> Result<()> {
        let label = string(&format!("docm-footnote-{name}"));
        if self.footnotes_emitted.contains(name) {
            self.out.push_str(&format!("#footnote(label({label}))"));
            return Ok(());
        }
        let Some(&definition) = self.footnotes.get(name) else {
            self.out.push_str(&markup(&format!("[^{name}]")));
            return Ok(());
        };
        self.footnotes_emitted.insert(name.to_owned());
        self.out.push_str("#footnote[");
        let blocks: Vec<Node> = definition.children().collect();
        if let [only] = blocks.as_slice()
            && matches!(only.data.borrow().value, NodeValue::Paragraph)
        {
            self.inline_children(only)?;
        } else {
            let saved = (self.seen_block, self.pending_pagebreak);
            self.seen_block = false;
            self.out.push('\n');
            let result = self.children(definition, Ctx { al: None, container: true, tight: false });
            (self.seen_block, self.pending_pagebreak) = saved;
            result?;
        }
        self.out.push_str(&format!("]#label({label})"));
        Ok(())
    }

    // -- assets -------------------------------------------------------------

    /// Validate and register a local image, returning its virtual path.
    fn asset(&mut self, url: &str, location: &Location) -> Result<String> {
        if url.starts_with("//") || has_url_scheme(url) {
            return Err(self.error("Images must use local filesystem paths, not URLs", location.clone()));
        }
        let path = self.base_dir.join(percent_decode(url));
        if !self.dependencies.contains(&path) {
            self.dependencies.push(path.clone());
        }
        if let Some(existing) = self.asset_paths.get(&path) {
            return Ok(existing.clone());
        }
        let data = std::fs::read(&path)
            .map_err(|error| self.error(format!("Cannot read image {}: {error}", path.display()), location.clone()))?;
        let extension = image_kind(&data).ok_or_else(|| {
            self.error(format!("{} is not a PNG, JPEG, GIF, WebP, or SVG image", path.display()), location.clone())
        })?;
        let virtual_path = format!("/assets/{}.{extension}", self.assets.len() + 1);
        self.assets.push((virtual_path.clone(), data));
        self.asset_paths.insert(path, virtual_path.clone());
        Ok(virtual_path)
    }
}

// ---------------------------------------------------------------------------
// Helpers

fn has_sentinel(node: Node) -> bool {
    node.children()
        .any(|child| matches!(&child.data.borrow().value, NodeValue::Text(text) if text.contains(SENTINEL_OPEN)))
}

pub fn plain_text(node: Node) -> String {
    let mut text = String::new();
    for descendant in node.descendants() {
        match &descendant.data.borrow().value {
            NodeValue::Text(value) => text.push_str(value),
            NodeValue::Code(code) => text.push_str(&code.literal),
            NodeValue::Math(math) => text.push_str(&math.literal),
            NodeValue::SoftBreak | NodeValue::LineBreak => text.push(' '),
            _ => {}
        }
    }
    text
}

fn strip_tags(text: &str) -> String {
    // Headings wrapped in macro tags contribute only their text to slugs.
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find('<') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('>') {
            Some(end) if is_macro_name(after[..end].trim_start_matches('/')) => rest = &after[end + 1..],
            _ => {
                out.push('<');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// GitHub-style heading slugs: lowercase, punctuation removed, spaces → `-`.
pub fn slugify(text: &str) -> String {
    text.trim()
        .to_lowercase()
        .chars()
        .filter_map(|c| match c {
            ' ' => Some('-'),
            '-' | '_' => Some(c),
            c if c.is_alphanumeric() => Some(c),
            _ => None,
        })
        .collect()
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let Ok(byte) = u8::from_str_radix(&text[index + 1..index + 3], 16)
        {
            out.push(byte);
            index += 3;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| text.to_owned())
}

fn image_kind(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        Some("gif")
    } else if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        Some("webp")
    } else {
        let head = String::from_utf8_lossy(&data[..data.len().min(4096)]);
        head.contains("<svg").then_some("svg")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> Config {
        let layer: crate::config::Layer = toml::from_str(crate::config::DEFAULTS).unwrap();
        crate::config::resolve(layer).unwrap()
    }

    fn body(markdown: &str) -> String {
        convert(markdown, Path::new("/doc/test.md"), 0, &config()).unwrap().body
    }

    fn error(markdown: &str) -> RenderError {
        convert(markdown, Path::new("/doc/test.md"), 0, &config()).unwrap_err()
    }

    #[test]
    fn escapes_all_markup() {
        assert_eq!(markup("a#b*c_d$e"), "a\\#b\\*c\\_d\\$e");
        assert_eq!(markup("x // y <z> @w"), "x \\/\\/ y \\<z\\> \\@w");
        assert_eq!(string("say \"hi\"\\\n"), "\"say \\\"hi\\\"\\\\\\n\"");
    }

    #[test]
    fn slugs_match_github() {
        assert_eq!(slugify("Hello, World!"), "hello-world");
        assert_eq!(slugify("Über `code`"), "über-code");
        let out = body("# A\n\n# A\n\n[x](#a-1)");
        assert!(out.contains("\"a\""));
        assert!(out.contains("\"a-1\""));
        assert!(out.contains("#link(label(\"a-1\"))"));
    }

    #[test]
    fn unknown_fragment_and_unsafe_scheme_links_lose_their_target() {
        let out = body("[a](#missing) [b](javascript:alert(1)) [c](https://x.y)");
        assert!(!out.contains("missing\")"));
        assert!(!out.contains("javascript"));
        assert!(out.contains("#link(\"https://x.y\")[c]"));
    }

    #[test]
    fn macros_wrap_blocks_and_stay_literal_in_code() {
        let out = body("<center>\n# Title\n\ntext\n</center>\n");
        assert!(out.contains("#docm-macro(\"center\", \"center\""));
        assert!(out.contains("#docm-heading(1, \"center\""));
        let out = body("```\n<center>\n```\n\n`<center>`");
        assert!(!out.contains("docm-macro"));
        let out = body("\\<center> literal");
        assert!(!out.contains("docm-macro"));
    }

    #[test]
    fn inline_and_heading_macros() {
        let out = body("<right>short</right>");
        assert!(out.contains("#docm-macro(\"right\", \"right\""));
        let out = body("# <center>Title</center>");
        assert!(out.contains("#docm-heading(1, \"center\""));
        assert!(error("# <center>Ti</center>tle").message.contains("whole heading"));
    }

    #[test]
    fn macro_errors_are_located() {
        let unclosed = error("text\n\n<center>\nmore\n");
        assert!(unclosed.message.contains("Unclosed"));
        assert_eq!(unclosed.location.unwrap().line, 3);
        let stray = error("text\n</center>\n");
        assert!(stray.message.contains("Unexpected closing"));
        assert_eq!(stray.location.unwrap().line, 2);
    }

    #[test]
    fn pagebreaks_attach_to_following_content() {
        let out = body(":::pagebreak\n\nA\n\n:::pagebreak\n:::pagebreak\n\nB\n\n:::pagebreak\n");
        assert_eq!(out.matches("pagebreak").count(), 1);
        assert!(error("- item\n\n  :::pagebreak\n").message.contains("not supported inside"));
        let out = body("```\n:::pagebreak\n```");
        assert!(!out.contains("#pagebreak"));
    }

    #[test]
    fn fences_dispatch_by_name() {
        let out = body(
            "```chronos\n_par(\"A\")\n```\n\n```typst\n#rect()\n```\n\n```rust\nfn x() {}\n```\n\n```math\nx^2\n```",
        );
        assert!(out.contains("import \"@preview/chronos:0.3.0\""));
        assert!(out.contains("_par(\"A\")"));
        assert!(out.contains("#[\n#rect()\n]"));
        assert!(out.contains("#docm-code(none, \"rust\""));
        assert!(out.contains("mimath(\"x^2\\n\")"));
    }

    #[test]
    fn diagraph_bodies_are_strings() {
        let out = body("```diagraph\ndigraph { a -> b }\n```");
        assert!(out.contains("diagraph.render(\"digraph { a -> b }\\n\")"));
    }

    #[test]
    fn images_must_be_local() {
        assert!(error("![x](https://example.com/a.png)").message.contains("local"));
        assert!(error("![x](//example.com/a.png)").message.contains("local"));
    }

    #[test]
    fn raw_html_is_literal() {
        let out = body("<div>hi</div>\n\ntext <b>x</b>");
        assert!(out.contains("\\<div\\>hi\\<\\/div\\>"));
        assert!(out.contains("\\<b\\>x\\<\\/b\\>"));
    }

    #[test]
    fn footnotes_render_at_first_reference() {
        let out = body("a[^n] b[^n]\n\n[^n]: Note.");
        assert_eq!(out.matches("#footnote[").count(), 1);
        assert!(out.contains("#footnote(label(\"docm-footnote-n\"))"));
    }
}
