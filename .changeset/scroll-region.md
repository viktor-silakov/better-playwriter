---
'better-playwriter': minor
---

1. **New helper `scrollRegion({ locator, by })`** scrolls the list that holds an element. It finds the scrolling element at, above or inside the locator, scrolls with the wheel so more rows load, and returns `{ scrolled, top, height, viewHeight, atStart, atEnd }`. A snapshot ref works too: `{ ref: '@e12', page, by }`.
2. **The scrolling-list note covers any labelled container** and gives the `scrollRegion` call.
