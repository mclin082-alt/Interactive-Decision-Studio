# Slide Studio PM Case Study

## One-Line Summary

Slide Studio is an AI presentation artifact studio that turns complex prompts into polished HTML-first presentations with narrative structure, interaction, data views, walkthroughs, editing, versioning, presentation, and export.

## User Problem

People can already ask AI tools to draft slides, but the workflow often breaks after the first draft:

- Output is hard to edit precisely
- Visual quality varies
- Work is not saved as a real project
- Presentation and export are separate manual steps
- Iteration history is easy to lose

The target user for this MVP is a PM, founder, technical operator, or job candidate who needs a presentation-ready artifact for a complex idea and wants to keep refining it.

## Product Goal

Build a credible end-to-end slide creation workspace:

1. Generate from a prompt, artifact type, and template
2. Preview the deck as real slides
3. Edit via chat or annotations
4. Save every project
5. Present fullscreen
6. Export HTML/PDF

## MVP Scope

Included:

- Email/password login
- Template library
- Prompt-to-HTML artifact generation
- Artifact type selection
- Chat edits
- Annotation edits
- Undo and versions
- Project history
- SQLite persistence
- Local HTML file storage
- Fullscreen presentation
- HTML/PDF export
- Demo account and sample projects

Deferred:

- Team collaboration
- Billing
- Cloud object storage
- PowerPoint export
- Slide-level asset library
- Real-time co-editing
- Advanced analytics

## Key Product Decisions

### HTML Artifacts First

HTML lets the product support high-fidelity layouts, animation, interaction, walkthroughs, data visualization, fullscreen presentation, and direct browser export. It also makes the generated artifact easy to inspect in a portfolio setting.

### Templates Before Blank Generation

Templates constrain the model toward a known visual system. This improves quality and helps users choose a direction before spending tokens.

### SQLite for the Portfolio MVP

SQLite keeps the system simple and deployable as a single service. It is enough for a portfolio demo and creates a clean migration path to Postgres or Supabase later.

### Local File Storage for Generated Decks

Generated HTML is a file artifact, while metadata belongs in the database. This separation keeps export and preview straightforward.

## Success Criteria

For a portfolio reviewer:

- They can open the app from a link
- They can log in with a demo account
- They can see sample projects immediately
- They can understand the core workflow in under three minutes
- They can inspect technical and product tradeoffs in the README/case study

For a user:

- They can generate a deck
- They can recover the deck after refresh
- They can edit it
- They can present it
- They can export it

## Architecture

The product is a single Node/Express service:

- Vite frontend served by Express
- SQLite database for structured data
- Local generated file directory for HTML deck files
- OpenAI-compatible chat completions API for generation/editing
- Headless Chrome for PDF export

Core tables:

- `users`
- `sessions`
- `decks`
- `deck_messages`
- `deck_comments`
- `deck_versions`
- `template_selections`
- `logs`

## Risks and Mitigations

### AI Output Quality

Risk: Generated HTML may be inconsistent.

Mitigation: Use strict generation prompts, fixed viewport rules, template design context, validation, and retry.

### Deployment Persistence

Risk: SQLite and generated files disappear on ephemeral disks.

Mitigation: Require a persistent disk mounted at `SLIDE_STUDIO_DATA_DIR`.

### API Key Handling

Risk: A shared server-side model key can create uncontrolled usage if the public app is abused.

Mitigation: Keep the key in deployment secrets, avoid exposing it to users, and add rate limits plus usage monitoring before public launch.

## Next Steps

1. Move persistence to Postgres/Supabase
2. Move files to object storage
3. Add PNG export and PowerPoint export
4. Add usage limits and account roles
5. Add stronger evals for generated deck quality
6. Add share links and reviewer comments
