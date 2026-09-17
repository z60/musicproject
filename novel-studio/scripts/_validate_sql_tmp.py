"""临时校验脚本（不属于交付物）：用 Python 内置 sqlite3 执行 001/002 SQL。

仅用于本机验证 SQL 文本可被 SQLite 接受（环境里没有 better-sqlite3）。
"""
import sqlite3
import sys
import os

base = os.path.join('src', 'main', 'infra', 'db', 'migrations')
con = sqlite3.connect(':memory:')
for name in ['001_init.sql', '002_seed.sql']:
    path = os.path.join(base, name)
    if not os.path.exists(path):
        print('MISSING', path)
        continue
    sql = open(path, encoding='utf-8').read()
    try:
        con.executescript(sql)
        print('OK', name, len(sql), 'chars')
    except Exception as e:
        print('FAIL', name, type(e).__name__, e)
        sys.exit(1)

tabs = [r[0] for r in con.execute(
    "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name")]
idxs = [r[0] for r in con.execute(
    "select name from sqlite_master where type='index' and name not like 'sqlite_%' order by name")]
views = [r[0] for r in con.execute("select name from sqlite_master where type='view' order by name")]
trigs = [r[0] for r in con.execute("select name from sqlite_master where type='trigger' order by name")]

print('TABLES', len(tabs))
print(tabs)
print('INDEXES', len(idxs))
print(idxs)
print('VIEWS', len(views), views)
print('TRIGGERS', len(trigs), trigs)
print('integrity_check', con.execute('pragma integrity_check').fetchall())
print('foreign_key_check', con.execute('pragma foreign_key_check').fetchall())

for v in views:
    try:
        con.execute('select * from "%s" limit 0' % v).fetchall()
        print('view ok  ', v)
    except Exception as e:
        print('view BROKEN', v, e)

print('settings rows', con.execute('select count(*) from settings').fetchall())
print('rule sets', con.execute('select count(*) from chapter_rule_sets').fetchall())
print('presets', con.execute('select count(*) from process_presets').fetchall())
print('meta', con.execute('select key, value from meta').fetchall())
