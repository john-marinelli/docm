//! Render a Markdown file's pages to PNGs: `cargo run --example pages -- doc.md OUT_PREFIX`.
use docm::config::ConfigSources;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let sources = ConfigSources::for_invocation(std::env::current_dir().unwrap(), None);
    let rendered = docm::render::render(args[1].as_ref(), &sources).unwrap_or_else(|e| panic!("{e}"));
    for (index, page) in rendered.document.pages().iter().enumerate() {
        let pixmap =
            typst_render::render(page, &typst_render::RenderOptions { pixel_per_pt: 1.0.into(), ..Default::default() });
        pixmap.save_png(format!("{}-{}.png", args[2], index + 1)).unwrap();
    }
    eprintln!("{} pages", rendered.document.pages().len());
}
