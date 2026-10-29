//! Compile a standalone .typ file in docm's sandboxed world (bundled fonts and
//! packages): `cargo run --example typst -- in.typ out.pdf`.
use docm::world::DocmWorld;
use typst_layout::PagedDocument;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let source = std::fs::read_to_string(&args[1]).unwrap();
    let world = DocmWorld::new(source, vec![], vec![], vec![]);
    match typst::compile::<PagedDocument>(&world).output {
        Ok(document) => {
            std::fs::write(&args[2], typst_pdf::pdf(&document, &Default::default()).unwrap()).unwrap();
            eprintln!("ok: {} pages", document.pages().len());
        }
        Err(errors) => errors.iter().for_each(|error| eprintln!("error: {}", error.message)),
    }
}
