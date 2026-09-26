# dx brand system

This directory owns the production dx identity. Read [the brand system](../../../../../wiki/brand-system.md) before changing its shape, behavior, or palette.

| Need | Use |
| --- | --- |
| Animated logo or product state | [`DxMark`](dx-mark.tsx) |
| Static wordmark or link | [`DxWordmark`](dx-wordmark.tsx) |
| Loading composition | [`DxLoading`](dx-loading.tsx) |
| Visual tokens and sizing | [`brand.css`](brand.css) |

- Import these components; do not redraw `dx`, copy the shader, or create feature-local logo CSS.
- Keep product state semantics in `DxMark`. Callers choose a state and size, not an animation recipe or color.
- Preserve the text fallback, reduced-motion behavior, and the motionless error state.
- Keep marketing typography and layout local to the marketing feature. Only the identity primitives belong here.
- Update affected components, shaders, tokens, tests, and the brand-system page together.
