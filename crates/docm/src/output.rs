//! Safe PDF output: never overwrite an input, replace destinations atomically.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

pub fn default_output_path(source: &Path) -> PathBuf {
    source.with_extension("pdf")
}

fn real_or_prospective(path: &Path) -> io::Result<PathBuf> {
    match fs::canonicalize(path) {
        Ok(real) => Ok(real),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
            match fs::canonicalize(parent) {
                Ok(parent) => Ok(parent.join(path.file_name().unwrap_or_default())),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(path.to_path_buf()),
                Err(error) => Err(error),
            }
        }
        Err(error) => Err(error),
    }
}

/// Reject destinations that are, resolve to, or hard-link an input or dependency.
pub fn validate_output_path(destination: &Path, protected: &[PathBuf]) -> Result<(), String> {
    let absolute = std::path::absolute(destination).map_err(|e| e.to_string())?;
    let parent = absolute.parent().ok_or("Output has no parent directory")?;
    if !parent.is_dir() {
        return Err(format!("Output parent is not a directory: {}", parent.display()));
    }
    let metadata = match fs::metadata(&absolute) {
        Ok(metadata) if !metadata.is_file() => {
            return Err(format!("Output is not a regular file: {}", absolute.display()));
        }
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
    };
    let destination_real = real_or_prospective(&absolute).map_err(|e| e.to_string())?;
    for path in protected {
        let protected_absolute = std::path::absolute(path).map_err(|e| e.to_string())?;
        let overwrite = || format!("Output would overwrite an input or dependency: {}", absolute.display());
        if protected_absolute == absolute {
            return Err(overwrite());
        }
        if real_or_prospective(&protected_absolute).map_err(|e| e.to_string())? == destination_real {
            return Err(overwrite());
        }
        #[cfg(unix)]
        if let (Some(destination), Ok(input)) = (&metadata, fs::metadata(&protected_absolute))
            && destination.dev() == input.dev()
            && destination.ino() == input.ino()
        {
            return Err(overwrite());
        }
    }
    Ok(())
}

/// Write to an exclusively created temporary file beside the destination,
/// sync it, then rename it into place. `precommit` can veto the rename; a
/// failure or veto leaves any existing destination untouched.
pub fn write_atomically(destination: &Path, bytes: &[u8], precommit: impl FnOnce() -> bool) -> Result<(), String> {
    let absolute = std::path::absolute(destination).map_err(|e| e.to_string())?;
    let parent = absolute.parent().ok_or("Output has no parent directory")?;
    let unique = format!(
        ".docm-{}-{}.tmp",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos())
    );
    let temporary = parent.join(unique);
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o644);
        let mut file: File =
            options.open(&temporary).map_err(|e| format!("Cannot create {}: {e}", temporary.display()))?;
        file.write_all(bytes).and_then(|()| file.sync_all()).map_err(|e| format!("Cannot write PDF: {e}"))?;
        drop(file);
        if !precommit() {
            return Err("The document changed before export completed".to_owned());
        }
        fs::rename(&temporary, &absolute).map_err(|e| format!("Cannot replace {}: {e}", absolute.display()))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_inputs_symlinks_and_hard_links() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("doc.md");
        fs::write(&source, "# x").unwrap();
        let protected = vec![source.clone()];
        assert!(validate_output_path(&source, &protected).is_err());
        #[cfg(unix)]
        {
            let link = dir.path().join("link.pdf");
            std::os::unix::fs::symlink(&source, &link).unwrap();
            assert!(validate_output_path(&link, &protected).is_err());
            let hard = dir.path().join("hard.pdf");
            fs::hard_link(&source, &hard).unwrap();
            assert!(validate_output_path(&hard, &protected).is_err());
        }
        assert!(validate_output_path(&dir.path().join("doc.pdf"), &protected).is_ok());
        assert!(validate_output_path(dir.path(), &protected).is_err());
    }

    #[test]
    fn atomic_write_and_veto() {
        let dir = tempfile::tempdir().unwrap();
        let destination = dir.path().join("out.pdf");
        fs::write(&destination, b"old").unwrap();
        assert!(write_atomically(&destination, b"new", || false).is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"old");
        write_atomically(&destination, b"new", || true).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"new");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1, "no temporary files left behind");
    }
}
