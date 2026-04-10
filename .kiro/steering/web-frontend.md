---
inclusion: fileMatch
fileMatchPattern: 'packages/web/**/*.tsx,packages/web/**/*.ts,packages/web/**/*.css'
---

# Web Frontend Conventions

## Tech Stack

React 19 + Vite 6 + TypeScript, Tailwind CSS v4 (CSS-first config), shadcn/ui, TanStack Query v5, React Router v7 (`react-router`, NOT `react-router-dom`), manual `EventSource` for SSE. Dark theme only.

## Tailwind v4 Critical Differences

```css
/* ✅ CSS-first import */
@import 'tailwindcss';
@import 'tw-animate-css'; /* NOT tailwindcss-animate */

/* ✅ Theme variables in @theme inline block */
@theme inline {
  --color-surface: var(--surface);
}

/* ❌ Never use @tailwind base/components/utilities */
```

Plugin: `@tailwindcss/vite` in `vite.config.ts` — Vite plugin, not PostCSS.

## Color Palette (oklch)

All custom colors are OKLCH. Key tokens in `:root` in `index.css`: `--surface`, `--surface-elevated`, `--background`, `--primary`, `--text-primary`, `--text-secondary`, `--success`, `--warning`, `--error`. Use via Tailwind: `bg-surface`, `text-text-primary`, `border-border`.

## SSE Streaming

`useSSE()` hook is the single SSE consumer. Batches text events (50ms flush), flushes immediately before `tool_call`/`tool_result`/`workflow_dispatch`. `handlersRef` pattern for stable EventSource with fresh handlers.

## Routing

```tsx
import { BrowserRouter, Routes, Route } from 'react-router'; // NOT react-router-dom
```

Routes: `/` (Dashboard), `/chat`, `/chat/*`, `/workflows`, `/workflows/builder`, `/workflows/runs/:runId`, `/settings`.

## API Types

Never import from `@archon/workflows` in `@archon/web`. Use re-exports from `@/lib/api` (derived from generated OpenAPI spec via `bun generate:types`).

## Anti-patterns

- Never add a light mode — dark-only is intentional
- Never use `react-router-dom` — use `react-router` (v7)
- Never configure Tailwind in `tailwind.config.js/ts` — v4 is CSS-first
- Never use `tailwindcss-animate` — use `tw-animate-css`
- Never open a second `EventSource` per conversation
- Never pass inline style objects for theme colors — use Tailwind classes with CSS variables
