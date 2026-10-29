use std::fmt;
use std::path::PathBuf;

/// A one-based position in an authored file (Markdown, TOML, or theme asset).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Location {
    pub path: PathBuf,
    pub line: usize,
    pub column: usize,
}

impl Location {
    pub fn new(path: impl Into<PathBuf>, line: usize, column: usize) -> Self {
        Self { path: path.into(), line: line.max(1), column: column.max(1) }
    }

    pub fn start(path: impl Into<PathBuf>) -> Self {
        Self::new(path, 1, 1)
    }
}

/// A user-facing rendering/configuration failure.
///
/// `dependencies` lists the files that influenced the failed attempt, so a
/// preview can keep watching them (including ones that do not exist yet) and
/// recover once they change.
#[derive(Debug, Clone)]
pub struct RenderError {
    pub message: String,
    pub location: Option<Location>,
    pub dependencies: Vec<PathBuf>,
}

impl RenderError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), location: None, dependencies: Vec::new() }
    }

    pub fn at(message: impl Into<String>, location: Location) -> Self {
        Self { message: message.into(), location: Some(location), dependencies: Vec::new() }
    }

    pub fn with_dependencies(mut self, dependencies: impl IntoIterator<Item = PathBuf>) -> Self {
        for dependency in dependencies {
            if !self.dependencies.contains(&dependency) {
                self.dependencies.push(dependency);
            }
        }
        self
    }
}

impl fmt::Display for RenderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.location {
            Some(location) => {
                write!(f, "{}:{}:{}: {}", location.path.display(), location.line, location.column, self.message)
            }
            None => f.write_str(&self.message),
        }
    }
}

impl std::error::Error for RenderError {}

pub type Result<T, E = RenderError> = std::result::Result<T, E>;

/// Convert a byte offset in `text` into a one-based line and column.
pub fn line_column(text: &str, offset: usize) -> (usize, usize) {
    let offset = offset.min(text.len());
    let before = &text[..floor_char_boundary(text, offset)];
    let line = before.matches('\n').count() + 1;
    let column = before.rsplit('\n').next().map_or(0, |rest| rest.chars().count()) + 1;
    (line, column)
}

fn floor_char_boundary(text: &str, mut offset: usize) -> usize {
    while !text.is_char_boundary(offset) {
        offset -= 1;
    }
    offset
}
