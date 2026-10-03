import { DatabaseSync } from 'node:sqlite'
const path = process.env.APPDATA + '/novel-studio/novel-studio.db'
const db = new DatabaseSync(path, { readOnly: true })
const books = db.prepare('SELECT id, title, char_count, chapter_count, created_at FROM books ORDER BY created_at DESC LIMIT 5').all()
for (const b of books) {
  const chars = db.prepare('SELECT COUNT(*) AS n FROM characters WHERE book_id = ?').get(b.id)
  const lines = db.prepare('SELECT COUNT(*) AS n, SUM(CASE WHEN character_id IS NOT NULL THEN 1 ELSE 0 END) AS assigned, SUM(CASE WHEN speaker_type = \'narration\' THEN 1 ELSE 0 END) AS narr FROM canvas_lines WHERE book_id = ?').get(b.id)
  console.log(JSON.stringify({ id: b.id, title: b.title, chars: chars.n, lines: lines.n, assigned: lines.assigned, narration: lines.narr }))
}
db.close()
