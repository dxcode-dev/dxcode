# Release readiness: artifacts

Status as of 2026-11-03. Owner: @[dx](agent).

## Summary

The storage layer and API are merged; the editor is in review. Two risks remain:

1. **Conflict handling** when the agent and a person save at once.
2. **Bundle size** of the editor chunk.

## Checklist

- [x] Storage and API (#1607)
- [ ] Web editor
  - [x] Round-trip tests
  - [ ] Conflict banner
- [ ] Phone sheet

## Numbers

| Metric | Before | After |
| --- | ---: | ---: |
| First-load JS (KB) | 412 | 412 |
| Editor chunk (KB) | — | 96 |

> Note: the editor chunk loads only when the Artifacts view opens.
>
> - quoted list item
> - another

---

```dx-view
<html><body><h1>Chart</h1></body></html>
```

See the [preview](https://example.com/preview) for details.
