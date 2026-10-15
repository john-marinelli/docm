# docm

>This project was created at level 7 of [this (great) framework](https://www.visidata.org/blog/2026/ai/#self-assessed-ai-level-for-contributions) for
self-assessing AI involvment in software. A detailed specification
was provided, but the implementation was left up to an agent.
The LLM-generated readme is at LLM_README.md(./LLM_README.md),
this one is entirely written by me.

This is docm, a simple program that can live(ish)-render a markdown
file and export it to pdf.

I wanted this for myself because if I'm going to be typing, I enjoy
doing it in neovim. I also tried out a few different setups for
writing markdown then rendering to a pdf, but I found any combination
of: previewing wasn't representative of the final product, configuration
was hard to manage, latex wasn't supported, mermaid wasn't supported,
etc.

That's why docm now exists, and I think it fixes a lot, if not all, of
the issues I've encountered. The configuration is done through TOML,
with defaults being what I consider sane and plain. The theme.toml
file you have in the directory where you launch docm will override whatever
defaults you put in there.

It's built using Electron, but I'm not super concerned with performance
or bundle size, so I'm fine with it for now. Originally I wanted to
support arbitrary latex, but that ballooned the size of things an insane
amount, so I switched things to use mathjax, which has so far been
more than enough.

## Usage

Here's a usage guide, still written by me.

### Live previewing

`docm <filename>`

