# cFLOWS — Chennai Flows

An evidence-first Chennai flood-nowcasting prototype built for SIH PS 26085. It combines public Greater Chennai Corporation drain geometry, rainfall forecasts, elevation, flood-news signals, citizen reports, and an on-demand EPA SWMM hydraulic run.

It is deliberately honest about its limits: public geometry is not a surveyed, connected citywide drainage network, and the street-level water projection is an exploratory scenario aid, not a validated emergency instruction.

## What it demonstrates

- A Chennai map with public drain geometry and click-to-inspect flow context.
- Plain-language flood questions via a local FreeLLMAPI-compatible endpoint.
- A scenario workspace: choose a place, set rainfall intensity, inspect the nearest mapped drain, and see an uncertainty-labelled street water projection.
- A drain-graph builder that records inferred endpoint links with confidence, while keeping confirmed survey topology separate.
- A historical calibration gate: IMD rainfall is replayed as event evidence, but depth accuracy stays blocked until time-matched flood labels and sub-daily rainfall are supplied.
- A two-tier scenario model: EPA SWMM for the selected drain reach, followed by an explicit surface-spill balance for the street-water range.
- Evidence ledger and data-source status rather than made-up sensor coverage.
- EPA SWMM runs that stop when essential drain dimensions or invert levels are missing.

## Run locally

Prerequisites: Node.js 20+ and npm. For hydraulic simulations, install EPA SWMM or build the bundled source with a supported C compiler.

```powershell
npm install
npm start
```

To enable the assistant, create `.env` from `.env.example` and either paste a FreeLLMAPI key as its only contents or configure `FREELLMAPI_API_KEY`. The default local API base URL is `http://127.0.0.1:31415/v1`.

```powershell
npm test
npm run build:swmm
```

## Data and modelling boundary

The app fetches public sources on demand. A location is matched to the nearest drain geometry in the GCC GIS layer; candidate neighboring drains are inferred from endpoint proximity and compatible invert direction, which is not the same as a surveyed topology. The model exposes that uncertainty rather than treating inferred connections as verified.

Historical IMD rainfall and public field reports are retained as evidence inputs. Rainfall alone cannot validate flood depth; defensible calibration also needs time-matched flood-depth observations, inundation extents, and confirmed drain connectivity. The import contract for historical labels is documented in `data/calibration/README.md`.

## Repository layout

- `src/` — UI, live-source adapters, decision logic, narration, and hydraulic helpers.
- `tests/` — automated checks for core decision behaviour and Electron entry point.
- `data/imd/` — IMD districtwise daily rainfall data used as a local evidence dataset.
- `vendor/epa-swmm/` — EPA SWMM upstream source, included as a Git submodule.

## Safety

cFLOWS is a decision-support prototype. Always defer to official disaster-management directions and do not use it as the sole basis for travel or emergency decisions.
