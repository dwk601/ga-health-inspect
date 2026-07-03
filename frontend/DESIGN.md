# GA Health Frontend Design Taste

A compact project design brief installed for future contributors and agents.

## Product read

A map-first Georgia public health establishment explorer. It should feel fast, civic, colorful, and trustworthy, not like a generic CRUD table.

## Taste rules

- Mobile first: the map is the product. Controls float over the map as a small search-first bottom sheet on phones and a compact left rail on desktop.
- Visual voice: calm dark civic map, high contrast, public-health green, inspection-score amber and red.
- Minimal feature set: search, score filter, permit-type chips, clustered map points, selected establishment detail, compact visible-results list, a small “Refresh this area” action after map movement, and a single “Near me” GPS action. Avoid extra buttons, descriptions, guides, or decorative panels unless they directly improve map reading.
- Performance: render points as MapLibre GeoJSON clusters through mapcn, not hundreds of DOM markers.
- Data honesty: GA Health API currently returns addresses but no lat/lng. The UI geocodes approximately from known Georgia city centers with deterministic jitter and labels this clearly.
- Loading and error states must stay beautiful and useful.

## Component rules

- Use `src/components/ui/map.tsx` from mapcn for the MapLibre map layer.
- Prefer one full-screen responsive app shell over separate desktop/mobile pages.
- Avoid giant feature lists; keep the page focused on exploring the map.
- Keep typography tight, high-contrast, and readable outdoors on phones.
