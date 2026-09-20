// Client-side entry. Intentionally minimal: the SSR HTML from src/app/render.tsx
// is already fully rendered and interactive-free by default (TRD §3.1). Add
// hydration/interactivity here only for components that genuinely need it —
// most of the kit's pages should stay static SSR to keep CPU cost near zero.
