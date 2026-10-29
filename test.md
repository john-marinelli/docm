<center>
# Hello
</center>

## This is docm

_hello_
**hello**

> hello

```python
def hello():
    print("hello")
```

```go
func main() {

}
```

```diagraph
digraph {
  rankdir=LR
  md -> parse -> typst -> pdf
  parse -> error [style=dashed, label="bad input"]
}
```

```chronos
_par("CLI"); _par("Typst")
_seq("CLI", "Typst", comment: "compile")
_seq("Typst", "CLI", comment: "PDF bytes", dashed: true)
```

```fletcher
node((0, 0), [Markdown]), edge("-|>"), node((1, 0), [PDF])
```

```cetz-plot
chart.piechart((3, 2, 1))
```

| hello | world |
|---|---|
| hello | world |
