# 3-Minute Demo Script

## 0:00-0:20 - Problem

"Slide Studio is an AI slide workspace for people who need polished presentation decks quickly, but still want control after generation. The product focuses on HTML slides because they can be interactive, editable, and exportable."

Show `/product.html`.

## 0:20-0:45 - Login and History

Open `/`.

Use:

- `demo@slidestudio.local`
- `demo1234`

Point out that this is not a throwaway demo: the user has a project history, server-managed AI generation, and seeded sample decks.

## 0:45-1:20 - Open a Project

Open "AI Creation Tool Launch".

Show:

- Project list
- Chat history
- Slide preview
- Page counter
- Template metadata

Say: "The core object is a deck project. Each generated or edited deck has metadata in SQLite and the actual HTML file in local storage."

## 1:20-1:55 - Edit Loop

Use chat:

"On slide 1, make the headline more executive and concise."

If you do not want to spend API time during a live interview, explain the flow and use a pre-edited sample. Mention undo and version history.

Then briefly show annotate mode:

"For targeted feedback, users can click a specific slide area, leave a note, and apply the edit."

## 1:55-2:25 - Presentation and Export

Click `Expand`.

Use arrow keys to navigate. Point out the bottom AI input in fullscreen.

Exit fullscreen.

Click:

- `Download HTML`
- `Export PDF`

Say: "This is the delivery moment: the deck is no longer trapped inside the editor."

## 2:25-2:50 - Technical Architecture

Open README architecture section or describe:

"The MVP is one Express app with a Vite frontend. SQLite stores users, sessions, projects, versions, messages, comments, template selections, and model config. Generated HTML files are stored locally. Docker packages Chromium so PDF export works in deployment."

## 2:50-3:00 - Product Framing

"The main product decision was to optimize for an end-to-end workflow rather than only generation quality: prompt, template, edit, save, present, export. The next production step would be Postgres/Supabase, object storage, billing, and team sharing."
