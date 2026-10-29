// docm's Typst helper library. Generated documents call these functions;
// `/config.typ` holds the resolved theme. Element styles are dictionaries:
//   (font, size, weight, style, align, leading, color, background,
//    above, below, inset, stroke-color, stroke-width, radius)
// Alignment arguments named `al` are formatting-macro overrides: when not
// `none` they replace the element's configured alignment.

#import "/config.typ": cfg

#let text-args(s) = (
  font: s.font, size: s.size, weight: s.weight, style: s.style, fill: s.color,
)

#let alignment(name) = if name == "center" { center } else if name == "right" { right } else { left }

#let effective(s, al) = if al == none { s.align } else { al }

#let stroke-of(s, edge) = {
  if s.stroke-width == 0pt or s.stroke-color == none { return none }
  let line = s.stroke-width + s.stroke-color
  if edge == "all" { line } else { ((edge): line) }
}

// Text and paragraph settings for an element, without its box.
#let styled(s, al, body) = {
  let a = effective(s, al)
  set text(..text-args(s))
  set par(leading: s.leading, justify: a == "justify")
  set align(alignment(a))
  body
}

// An element box: spacing, padding, background, border and typography.
#let docm-block(s, body, al: none, edge: "all", breakable: true) = block(
  width: 100%,
  above: s.above, below: s.below,
  inset: s.inset, fill: s.background, radius: s.radius,
  stroke: stroke-of(s, edge),
  breakable: breakable,
  styled(s, al, body),
)

#let docm-par(al, body) = docm-block(cfg.paragraph, body, al: al)

#let docm-heading(level, al, lbl, body) = {
  let s = cfg.headings.at(level - 1)
  show heading: it => docm-block(s, al: al, breakable: false, {
    if it.numbering != none { counter(heading).display(it.numbering) + h(0.4em) }
    it.body
  })
  [#heading(level: level, body)#label(lbl)]
}

#let docm-toc() = docm-block(cfg.paragraph, outline(title: [Contents], depth: 6))

#let docm-quote(al, body) = docm-block(cfg.blockquote, body, al: al, edge: "left")

#let docm-code(al, lang, text) = docm-block(cfg.code, al: al, {
  raw(block: true, lang: lang, text)
})

#let docm-list(al, tight, ordered, start, items) = docm-block(cfg.list, al: al, {
  let spacing = if tight { auto } else { cfg.paragraph.below }
  if ordered {
    enum(start: start, tight: tight, spacing: spacing, indent: 0pt, body-indent: cfg.list-indent / 2, ..items)
  } else {
    list(tight: tight, spacing: spacing, indent: 0pt, body-indent: cfg.list-indent / 2, ..items)
  }
})

#let docm-task(checked, body) = {
  box(baseline: 0.15em, width: 0.8em, height: 0.8em, stroke: 0.06em + cfg.list.color, radius: 0.1em,
    if checked { align(center + horizon, text(size: 0.75em, sym.checkmark)) })
  h(0.4em)
  body
}

#let docm-table(al, aligns, header, rows) = {
  let s = cfg.table
  let columns = aligns.len()
  let cell-align = aligns.map(a => alignment(if al != none { al } else if a == none { s.align } else { a }))
  // Padding/border belong to the cells; the outer box only spaces the table.
  docm-block((..s, inset: 0pt, background: none, stroke-width: 0pt), al: al, {
    table(
      columns: (1fr,) * columns,
      align: (x, y) => cell-align.at(x) + top,
      inset: s.inset,
      stroke: if s.stroke-width == 0pt or s.stroke-color == none { none } else { s.stroke-width + s.stroke-color },
      fill: (x, y) => if y == 0 { cfg.table-header-background } else if calc.even(y) { cfg.table-stripe-background } else { none },
      table.header(..header),
      ..rows.flatten(),
    )
  })
}

#let docm-rule() = {
  let s = cfg.rule
  block(width: 100%, above: s.above, below: s.below, inset: (y: s.inset),
    line(length: 100%, stroke: if s.stroke-width == 0pt or s.stroke-color == none { none } else { s.stroke-width + s.stroke-color }))
}

// Fit artwork into the available width and printable height without
// distorting it. Natural sizes only shrink; explicit sizes may enlarge.
#let fit(body, width: none, height: none, max-height: none) = layout(size => {
  // Bounded by the available width: some packages size themselves to it.
  let natural = measure(width: size.width, body)
  if natural.width == 0pt or natural.height == 0pt { return body }
  let max-w = size.width
  let max-h = if max-height == none { cfg.content-height } else { max-height }
  let factor = if width == none and height == none {
    calc.min(1, max-w / natural.width, max-h / natural.height)
  } else {
    let factors = ()
    if width != none { factors.push(width / natural.width) }
    if height != none { factors.push(height / natural.height) }
    calc.min(..factors, max-w / natural.width, max-h / natural.height)
  }
  if factor == 1 { body } else { scale(factor * 100%, reflow: true, body) }
})

#let docm-image(al, path, alt) = {
  let s = cfg.image
  let a = if al != none { al } else { cfg.image-align }
  let inset = 2 * (s.inset + s.stroke-width)
  docm-block(s, al: a, breakable: false,
    fit(image(path, alt: alt), max-height: cfg.content-height - inset))
}

#let docm-inline-image(path, alt) = box(fit(image(path, alt: alt)))

#let docm-math-text(body) = {
  set text(size: cfg.math.size, fill: cfg.math.color)
  body
}

#let docm-math(al, eq) = block(width: 100%, above: cfg.math.above, below: cfg.math.below, {
  set align(alignment(if al != none { al } else { "center" }))
  docm-math-text(eq)
})

#let docm-diagram(chart, al, body) = docm-block(chart.style, al: al, breakable: false, {
  set text(..text-args(chart.style))
  fit(body, width: chart.width, height: chart.height,
    max-height: cfg.content-height - 2 * (chart.style.inset + chart.style.stroke-width))
})

// Formatting macros. Alignment-only macros are plain scopes, so page breaks
// still work inside them; layout macros are boxes.
#let docm-macro(name, al, width, height, body) = {
  if width == none and height == none { return { set align(alignment(al)) if al != none; body } }
  block(width: if width == none { auto } else { width }, height: height, breakable: height == none, {
    set align(alignment(al)) if al != none
    if height != none {
      layout(size => {
        let used = measure(width: size.width, body).height
        if used > height {
          panic("Content of <" + name + "> needs " + repr(used) + " but the macro height is " + repr(height) + "; increase height or remove it")
        }
      })
    }
    body
  })
}

// A floated macro sits beside the prose that follows it (up to the next
// heading, rule, page break or float), as two columns.
#let docm-float(side, width, float-body, rest) = {
  let gap = 12pt
  let float-column = if width == none { auto } else { width }
  let columns = if side == "left" { (float-column, 1fr) } else { (1fr, float-column) }
  let cells = if side == "left" { (float-body, rest) } else { (rest, float-body) }
  grid(columns: columns, column-gutter: gap, ..cells)
}

#let decoration-row(d, slots, logo) = {
  set text(..text-args(d))
  set par(leading: d.leading)
  let cell(slot, body) = {
    let parts = ()
    if logo != none and logo.position == slot { parts.push(box(fit(image(logo.path), width: logo.width, height: logo.height))) }
    if body != none { parts.push(body) }
    align(alignment(slot) + horizon, stack(dir: ltr, spacing: 0.5em, ..parts))
  }
  grid(columns: (1fr, 1fr, 1fr), column-gutter: 8pt,
    cell("left", slots.left), cell("center", slots.center), cell("right", slots.right))
}

#let check-decoration(name, body, available, setting) = context {
  let height = measure(width: page.width - cfg.margins.left - cfg.margins.right, body).height
  if height > available {
    panic("The " + name + " needs " + repr(height) + " but only " + repr(available) + " fits in the margin; increase " + setting)
  }
}

#let docm-document(header: none, footer: none, body) = {
  let decoration-space(margin) = margin * 0.7
  set page(
    width: cfg.page-width, height: cfg.page-height,
    margin: cfg.margins,
    fill: cfg.body.background,
    header-ascent: 30%, footer-descent: 30%,
    header: if header == none { none } else { context {
      check-decoration("header", header, decoration-space(cfg.margins.top), "page.margins.top")
      align(bottom, header)
    } },
    footer: if footer == none { none } else { context {
      check-decoration("footer", footer, decoration-space(cfg.margins.bottom), "page.margins.bottom")
      align(top, footer)
    } },
  )
  set text(..text-args(cfg.body), top-edge: 0.8em, bottom-edge: -0.2em, hyphenate: false)
  set par(leading: cfg.body.leading, justify: cfg.body.align == "justify", spacing: cfg.paragraph.below)
  set heading(numbering: if cfg.number-headings { "1.1" } else { none })
  show math.equation: set text(font: cfg.math.font)
  show link: it => {
    set text(..text-args(cfg.link))
    if cfg.link-underline { underline(it) } else { it }
  }
  set raw(theme: cfg.code-theme) if cfg.code-theme != auto
  show raw: set text(font: cfg.code.font, size: cfg.code.size)
  show raw.where(block: false): it => box(
    fill: cfg.inline-code.background, inset: (x: 0.2em), outset: (y: 0.2em), radius: cfg.inline-code.radius,
    text(..text-args(cfg.inline-code), it),
  )
  show raw.where(block: true): it => {
    set text(..text-args(cfg.code))
    set par(leading: cfg.code.leading)
    if cfg.code-line-numbers {
      show raw.line: line => box(width: 2.5em, align(right, text(fill: cfg.code.color.transparentize(50%), str(line.number)))) + h(1em) + line.body
      it
    } else { it }
  }
  show footnote.entry: set text(..text-args(cfg.footnotes))
  set footnote.entry(separator: line(length: 30%, stroke: 0.5pt + cfg.rule.stroke-color))
  set document(title: cfg.title)
  body
}
