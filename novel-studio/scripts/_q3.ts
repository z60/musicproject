import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { alignLinesToAsr } from '../src/shared/audio/asr-align.ts'
import { alignCharsMonotone } from '../src/shared/audio/char-align.ts'
const dump = JSON.parse(readFileSync(process.env.TEMP + '/asr-2221-new.json', 'utf8')) as { segments: Array<{startMs:number;endMs:number;text:string}>; tokens: Array<{text:string;startMs:number;endMs:number}> }
const db = new DatabaseSync(process.env.APPDATA + '/novel-studio/novel-studio.db', { readOnly: true })
const fp = 'imports/1791049434047-2221-旁白-语心草.wav'
const takes = db.prepare("SELECT line_id, src_in_ms FROM takes WHERE file_path=? AND is_selected=1 AND deleted_at IS NULL ORDER BY src_in_ms").all(fp) as Array<{line_id:string;src_in_ms:number}>
const lines = takes.map(t => { const r = db.prepare('SELECT seq, text FROM canvas_lines WHERE id=?').get(t.line_id) as {seq:number;text:string}; return { lineId: t.line_id, text: r.text, seq: r.seq } })
const r = alignLinesToAsr({ segments: dump.segments, tokens: dump.tokens, lines: lines.map(l=>({lineId:l.lineId,text:l.text})), durationMs: 213053 })
const a = alignCharsMonotone(dump.tokens, lines.map(l=>({lineId:l.lineId,text:l.text})))
for (let i = 0; i < lines.length; i++) {
  const s = a.spans[i]!; const g = r.ranges[i]!
  console.log(String(i).padStart(2) + ' seq' + String(lines[i]!.seq).padStart(3) + ' ' + String(Math.round(g.startMs)).padStart(7) + '~' + String(Math.round(g.endMs)).padStart(7) + ' cov=' + s.coverage.toFixed(2) + ' u=' + s.firstUnit + '..' + s.lastUnit + ' endHint=' + s.endHintMs + ' | ' + lines[i]!.text.slice(0, 26))
}