# SQL Explorer

Work with your SQL databases — MySQL, PostgreSQL and ClickHouse — right
inside RocketRide: browse the schema, page through rows, write and run SQL,
read a query plan, review the schema's health, draw the relationship
diagram, and stage table changes with the DDL spelled out before anything
runs.

<p align="center">
  <img src="./assets/screenshot.png" alt="SQL Explorer" width="900">
</p>

Every statement travels through a RocketRide database node, so it reaches
exactly the database that node is configured for, with that node's
permissions — whether that node lives in one of your pipelines or in a small
tool pipeline the app runs for you (see [Connections](#connections)). If
apps are new to you, read
[Apps](../../docs/public/product/concepts/apps.md) first. What the app
deliberately does not do is under [Limits](#limits); most of those gaps come
from the tool protocol rather than from the app.

SQL Explorer runs in the RocketRide shell as an app, and as a dev tool: in
rocket-ui's tool panel and inside the RocketRide VS Code extension, where
the connection list sits in the sidebar and each connection opens as its own
document. It is the same app either way, and your connection list follows
you between them; what differs in a dev tool is under
[As a dev tool](#as-a-dev-tool).

## Before you start

- **A reachable database.** The supported engines are the ones with database
  nodes: [`db_mysql`](../../nodes/src/nodes/db_mysql/README.md),
  [`db_postgres`](../../nodes/src/nodes/db_postgres/README.md),
  [`db_clickhouse`](../../nodes/src/nodes/db_clickhouse/README.md) and
  [`rocketride_sql`](../../nodes/src/nodes/rocketride_sql/README.md), plus
  `db_supabase`, the Supabase preset of the `db_postgres` node (see its
  [Supabase section](../../nodes/src/nodes/db_postgres/README.md#supabase-preset)),
  which shares the PostgreSQL implementation and reports the `postgres`
  dialect. You either point the app at a database node already running in one
  of your pipelines, or give it the connection details directly — both under
  [Connections](#connections).
- **Direct execution, if you want to run statements.** Each database node
  has an **Allow direct query execution** setting (`allow_execute`), off by
  default and worth leaving off until a caller truly needs it. With it off,
  schema browsing, the diagram and the Insights page still work; statements
  do not. The first refused statement raises a banner: `This node does not
  allow execute (allow_execute is off). Schema browsing works; statements
  cannot run.` For a pipeline-bound connection the setting belongs to that
  pipeline's node; for a direct connection it is part of the configuration
  you enter yourself.

## Connections

The sidebar carries your connection list. Each saved connection is a row;
hovering one offers edit and delete, **+ New Connection** opens the add
dialog, and clicking a row opens that database's workbench. The list is
saved per user on the server you are connected to, so the same connections
appear in the shell, in the App Builder preview and in VS Code.

<p align="center">
  <img src="./assets/new-connection.png" alt="Adding a connection" width="700">
</p>

**New Connection** offers two paths:

- **From pipeline** finds the database nodes in the pipelines you are
  running yourself (your own development runs) and lets you pick one. The
  connection stays bound to that node: it is usable while that pipeline runs
  and goes dark when it stops, and statements run with exactly that node's
  configuration and permissions. A team deployment of a pipeline is not
  offered here: a saved connection names a pipeline by its project, source
  and node, which is what your own run of it is found by. An empty list
  here means none of your running pipelines has a database node.
- **Direct** takes the connection details itself — you pick the engine and
  fill in the same configuration form the pipeline editor uses, host and
  credentials included. When you open a direct connection, the app starts a
  small temporary tool pipeline holding just that database node, and stops
  it again when you close the connection's last document (an idle one is
  reaped after 15 minutes either way; the app restarts it transparently the
  next time you run something).

One thing to know about direct connections: the configuration is stored
as typed in your per-user file on the server. For passwords and other
secrets, use a `${ROCKETRIDE_*}` environment reference instead of the
literal value — the server stores those encrypted.

Opening a connection finds the running pipeline it names: your own
development run of that pipeline, or, for a direct connection, its temporary
pipeline, started first if it is not running. A connection whose pipeline is
not running says so instead of opening. Signing out, or signing in as
another user, organization or team, clears the connection list, which is
read again for the new sign-in, and closes every document that belonged to a
connection (workbench, query, data browser, designer, diagram and connection
editor), so the previous account's results are not left on screen; a
dropped connection alone closes nothing. The app never holds a connection
string or a task token in anything it saves or shows: task tokens are kept in
memory only, where the engine connection is.

Each row also says how its connection stands, from what the app already
knows (nothing is sent to find out):

- **Running** or **Stopped**, for a pipeline connection: whether your own
  run of that pipeline is running. Opening one whose pipeline is not
  running leaves it Stopped; start the pipeline and the row turns Running.
- **Direct**, for a direct connection, or **Open** while its temporary
  pipeline runs.
- **Unreachable**: the connection failed to open (until it opens, or the
  app next sees its pipeline running), or its pipeline runs but the
  database node does not answer.
- **No access**: its pipeline runs, but your role may not call the
  database node (a team deployment you can see but not use).

Hovering the word gives the reason. The words follow pipelines starting and
stopping as the engine reports them; until the app has first looked at your
running pipelines, a pipeline row says nothing.

Opening a connection gives it a workbench document and fills the sidebar
with that database's tables. Everything else hangs off a connection: query
documents, the data browser, the designer and the diagram are each pinned to
one for life, and two documents on two connections never see each other's
history or settings.

## The connection workbench

**Overview** counts the tables, columns and foreign keys, names the dialect,
and lists the tables in the connection's default schema. Clicking a table
row opens that table's Data page; the **Details** button on the row opens its
record drawer instead. The header of Overview, Insights and Diagram carries
**Refresh Schema**, **Shortcuts** and **New Query**. Query, Data and Design
show their own header and no other, so each page has one.

**Insights** reads the same snapshot and says what shape it is in. See
[Insights](#insights). **Diagram** draws the tables and their declared
relations; clicking a table in it opens that table's Data page. See
[Relationships](#relationships).

Press **?** anywhere outside a text field or the SQL editor, or use the
**Shortcuts** button, to list the keyboard shortcuts.

When a connection opens, the app sends `SELECT 1` once to find out whether
the node runs statements. It goes straight to the node, so it is not in your
query history. If the node has `allow_execute` off, the connection is
**schema only**: the header says so, and Run, Run all, Explain, New Query,
**Select top 100**, **Count rows**, **Open data** and History's **Rerun** are
off with the reason shown, and the Data page says it cannot read rows. The
run shortcuts send nothing either and say why, so no statement, and no row
estimate for a confirmation, reaches the node. Tables, columns, keys,
Diagram and Insights keep working. After you turn `allow_execute` on and
restart the pipeline, **Check again** on the Overview page (or **Refresh
Schema**) looks again. While the answer is not known yet, nothing is
disabled.

Both pages read one schema snapshot. The node reflects the database when the
pipeline task starts and serves that reflection to every caller, so the
snapshot is a point-in-time reading, not a live view. Panels derived from it
say so: `from schema snapshot HH:MM`.

## Browsing a table

A table document pages rows through the grid: page size and page number go
straight into `LIMIT` and `OFFSET`, per-column filters, filter chips and the
search box become a bound `WHERE` clause, and a column sort becomes
`ORDER BY`. Paging stays on `OFFSET` because the pager can jump to any page,
which a keyset cursor cannot do; on a very large table the deep pages are
slow for that reason.

### Search and filters

The search box looks in the text columns and ignores case. Each engine gets
its own form: `col::text ILIKE` on PostgreSQL, `LOWER(col) LIKE LOWER(...)` on
MySQL, `toString(col) ILIKE` on ClickHouse, and a plain `LIKE` on an engine the
app does not know. A `%`, `_` or `\` you type matches itself rather than acting
as a wildcard. The header filters match the same way.

**+ Filter** adds a chip above the grid: a column, an operator (equals, not
equals, contains, starts with, `>`, `<`, `≥`, `≤`, is null, is not null) and a
value. What you type is sent to the database separately from the statement,
never pasted into it, and `is null` and `is not null` send no value. On a
number or yes/no column the value is sent as a number or a boolean, so `5`
compares as 5. Chips, header filters and the search box all apply together
(AND). The grid's sorters show as chips too; removing one clears that sort.
Any change goes back to page 1.

### Counting rows

The total in the pager is counted once per filter. Paging, and changing the
sort or page size, reuse it; a new search, header filter or chip counts again.

On a table with no filter, the app first reads the engine's own row estimate
(`pg_class.reltuples`, `information_schema.TABLES.TABLE_ROWS`,
`system.tables.total_rows`) instead of scanning. From 100,000 rows up, the
grid shows `About N rows (estimate)` with a **Count exactly** button, and the
estimate can be well off (MySQL's often is, by 40 to 50 percent). An estimate
of -1 or NULL, which PostgreSQL gives for a table it has not analyzed, means
the app counts exactly.

A filtered search on one of those large tables is not counted at all. Each
page asks for one row more than it shows, and when that row comes back the
note says `More rows match` and the pager offers a next page. **Count
exactly** counts it.

A connection that cannot run statements (schema only) gets no page, count or
estimate statement from the browser.

### Opening a row

Click a row to open it. The drawer lists every column in the table's own
order, with its type, a `PK` mark where it applies, and a copy button for each
value and for the whole row as JSON. Prev and Next move through the page; the
title reads `Row N` counting from the first row of the table. A value is shown
as the browser received it (see [Results](#results)): very large numbers and
decimals may be shown rounded.

A value that belongs to a foreign key is a link. It runs `SELECT * FROM
<referenced> WHERE <key> = $1 LIMIT 2` (every column of a composite key, with
the values sent separately) and opens that row in a drawer on top, with a back arrow and a Back
button. If nothing matches, the drawer says so; if more than one row matches,
it shows the first and says that too. A NULL key is not a link. A key that
reached the browser as a number past 2^53 (9,007,199,254,740,992) was already
rounded on the way, and could be another row's key, so it is not looked up:
the link is off and says `This key is too large to look up exactly in the
browser.` A key the node sends as text is exact and is followed as usual.

**Rows that reference this one** lists the tables whose foreign keys point at
the row's table. **Show rows** opens that table's data with a chip already set
to this row's key, and is off, with the same reason, for a key too large to
hold exactly. Foreign-key columns also say where they point in the
column's header tooltip, for example `BIGINT → customers.id`.

With no sort of your own, the app orders by the primary key so paging is
repeatable. A table with no primary key and no sort has no `ORDER BY` at
all, and SQL promises nothing about row order between pages in that case, so
the browser says `No primary key — page order is not guaranteed by the
database` above the grid rather than letting you find out by seeing a row
twice.

## Writing and running queries

A query document is a SQL editor over the results grid.

<p align="center">
  <img src="./assets/query.png" alt="Running a query" width="900">
</p>

### What a run sends

The node's `execute` tool takes one statement per call, so a buffer holding
several statements is split in the app before anything is sent. Three ways
to run:

- **Run** sends the selection if there is one, otherwise the statement your
  caret is in (`Ctrl/Cmd+Enter`).
- **Run all** sends every statement in the buffer, in order, and stops at
  the first error (`Ctrl/Cmd+Shift+Enter`).

Before you press anything, the line under the editor names what a run would
send: `Will run: statement 2 of 3 (lines 4–6)`, or `Will run: selection
(lines 2–3)`, or `Will run: nothing (editor is empty)`. The editor highlight
and that line always agree. After a batch, a strip above the results carries
one entry per statement, and selecting an entry shows that statement's rows.

The splitter understands strings, quoted identifiers, line and block
comments, and PostgreSQL dollar-quoted bodies, so a semicolon inside any of
those is not a separator. Each dialect's own rules apply: MySQL needs
whitespace after `--` before it is a comment (`SELECT 1--2` is arithmetic),
and a `$tag$` that continues an identifier opens no PostgreSQL dollar quote.
MySQL's `DELIMITER` directive is **not**
supported: a buffer that changes the terminator mid-file splits wrongly, so
run stored-routine definitions through the MySQL client instead.

### Each statement commits on its own

Plain `execute` wraps every call in its own transaction. A batch that fails
on statement 3 therefore leaves 1 and 2 applied, and the error banner says
so. The outcome line names read statements as `ran` and write or DDL
statements as `committed`, for example `1 ran · 2 committed · 3 failed · 4–5
not run`.

For the same reason `BEGIN`, `COMMIT` and `ROLLBACK` are refused before
anything is sent: `Transaction statements have no effect here: each
statement runs and commits on its own.` The node does have a transaction
surface (`begin` / `commit` / `rollback` with a session id), but SQL
Explorer does not use it, and transaction control that quietly does nothing
would be worse than a refusal.

A statement is sent a second time in one case only. When the pipeline task
is stopping or restarting, the engine refuses a statement with
`TASK_STOPPED` before the statement reaches the database, so nothing has run.
A statement the app classifies as a read is then sent once more, after the
same connection is running again within 15 seconds; a write never is. The
classification is by text: a `SELECT … INTO`, which fills a new table, a file
or variables (see [The row limit](#the-row-limit)), counts as a write and is
never re-sent, but a read that changes something through a function
(`nextval` or another volatile function) counts as a read here. It is still
never run twice, because the refusal comes before the database sees it. A
statement that reached the database is never re-sent, whatever happens to
its answer. As a dev tool the sidebar checks this again for every statement
it is sent, with the dialect the database node reports (it asks the node
when it does not know yet), so a write is never repeated whichever document
sent it. If the node cannot say which dialect it speaks, the statement is
sent once and never repeated. In VS Code the engine's refusal code does not
reach SQL Explorer, so there the statement is not sent again and the
refusal is shown.

The check reads the statement's text, not the server's settings. A setting
that changes how the server reads text (MySQL's `NO_BACKSLASH_ESCAPES` or
`ANSI_QUOTES`, PostgreSQL with `standard_conforming_strings` off) is not
taken into account, and a read that changes something through a function (`SELECT
nextval('s')`) still counts as a read.

### The row limit

The header toggle offers **200**, **1000** and **All**, applied to
row-returning statements. The results line states what was applied: `1,000
rows returned (limit 1000)` when SQL Explorer appended the limit, `N rows
returned (limit in statement)` when the statement's OUTERMOST query carries
its own `LIMIT` — one inside a subquery bounds that subquery, not the result,
so on **200** or **1000** the app still appends its own — or `N rows returned
(no limit applied)` when nothing bounds the result.

Read `no limit applied` literally, because **All** together with a `LIMIT`
that is not on the outermost query produces exactly that line. Only a
top-level `LIMIT` is recognised, so

```sql
SELECT o.*
FROM orders o
JOIN (SELECT customer_id FROM customers LIMIT 10) c
  ON c.customer_id = o.customer_id
```

run with **All** counts as carrying no limit: nothing is appended and the
line reads `no limit applied`. That is not a mistake in the reading — the
inner `LIMIT 10` bounds the customer subquery, and the statement can still
return every order belonging to those ten customers. The line describes the
RESULT, not the text. Choose **200** or **1000** to have a limit appended to
the outer query, or move the `LIMIT` to the top level, to bound what comes
back.

A statement that ENDS in a locking clause — `FOR UPDATE`, `FOR NO KEY
UPDATE`, `FOR SHARE`, `FOR KEY SHARE` or MySQL's `LOCK IN SHARE MODE` — gets
the limit INSERTED in front of that clause instead of appended after it, and
the line reads `limit 200` like any other bounded read. The two engines
differ on the order: MySQL documents `[LIMIT …] [FOR UPDATE | LOCK IN SHARE
MODE]` and rejects a `LIMIT` that follows the clause, while PostgreSQL
accepts either order — so putting the limit first is the one placement valid
on both, and the read stays bounded rather than streaming the whole table.
Your clause is otherwise untouched: its `OF` list, `NOWAIT` and `SKIP LOCKED`
are sent exactly as you typed them. A statement that already ends in its own
`OFFSET` keeps the appended form, because a `LIMIT` in front of the clause
would leave the `OFFSET` stranded behind it. A statement bounded by
`FETCH { FIRST | NEXT } … { ROW | ROWS } ONLY` is recognised the same way a
`LIMIT` is: SQL Explorer treats it as the statement's own limit and sends it
unchanged, locking clause and all — `SELECT … FETCH FIRST 10 ROWS ONLY FOR
UPDATE` goes out exactly as typed, and the line reads `limit in statement`
rather than `limit 200`.

That in-statement treatment holds whichever header option is selected —
**200**, **1000** and **All** all read `limit in statement` for a
self-bounded statement — and it covers `FETCH … WITH TIES` too, even though
`WITH TIES` can hand back more rows than the stated count: the line never
claims that number is a hard maximum, only that the statement carries its
own bound. As with `LIMIT`, only a `FETCH` on the outermost query counts —
one inside a subquery or a CTE body bounds that inner result, not what SQL
Explorer returns, so the outer query still gets the header's `LIMIT`
appended. A bare `OFFSET` is never a limit on its own, FETCH terms or
otherwise, so it doesn't change any of this. `FETCH` is also how PostgreSQL
spells advancing a cursor — `FETCH NEXT FROM mycursor` — which isn't a
`SELECT` and so never reaches this rewrite at all. MySQL has no `FETCH
FIRST` clause (MariaDB 10.6+ does); a statement using it is invalid MySQL
independent of anything SQL Explorer does, so it is left alone for the
server to report.

A locking clause that sits behind a `#` on the same line is left alone: the
statement goes out exactly as typed and the line reads `no limit applied`.
`#` starts a comment in MySQL only, so on any other connection — including one
whose dialect could not be probed — the app cannot tell a commented-out `# for
update` from a real clause, and moving the limit in front of it would lift the
clause out of the comment. On a PostgreSQL connection this also costs the
limit on a statement that uses `#` as an operator on that line — and, on a
statement that carries its own `LIMIT` or `FETCH` clause, it costs the `limit
in statement` reading too, even though the statement is genuinely bounded;
write the statement on two lines to have it bounded.

The same ambiguity applies to the statement's OWN limit clause. A `LIMIT` or
`FETCH { FIRST | NEXT } … ONLY` that sits behind an unmasked `#` on the same
line reads as `no limit applied`, not `limit in statement`, on any connection
but MySQL — including one whose dialect could not be probed, where a MySQL
server is a live possibility. On MySQL that text is an ordinary comment and
the statement runs with no bound at all, so claiming `limit in statement`
would report a bound that does not exist on the server that actually runs it.
Nothing is rewritten: the statement goes out exactly as typed either way,
only the reported line changes.

One exception, older than this rule: a `WITH` chain that contains `FOR
UPDATE` or `FOR NO KEY UPDATE` anywhere — in a CTE body as much as in the
chain's own last clause — is read as a data-modifying chain, because the
`UPDATE` of the clause is taken for the chain's verb. Such a chain is treated
as a write, gets no limit and reads `no limit applied`. A chain whose only
locking clause is `FOR SHARE` or `FOR KEY SHARE` is bounded normally. That is
a gap in how a `WITH` chain is classified, not in the limit rule.

A `SELECT … INTO` returns no rows: PostgreSQL's `SELECT … INTO new_table`
creates and fills a table, MySQL's `INTO OUTFILE`, `INTO DUMPFILE` and `INTO
@variable` write a file or variables, and ClickHouse's `INTO OUTFILE` writes a
file. Nothing is appended to one, whatever the header says, because a limit
would silently cut the copy short. It goes out exactly as typed and counts as
a statement that changes data: it is never retried after a restart, History
lists it with the writes, and re-running it from History asks first.

ClickHouse's `LIMIT n BY expr` caps the rows of each group, not the result,
so it is not read as the statement's own limit (on ClickHouse, and on a
connection whose dialect could not be probed). On **200** or **1000** the
header's `LIMIT` is appended after it, which ClickHouse accepts, and the line
reads `limit 200`; with **All** it reads `no limit applied`. A plain `LIMIT`
after the `BY` list is the statement's own limit, as anywhere else.

ClickHouse puts its `SETTINGS` and `FORMAT` clauses after every `LIMIT` and
rejects a `LIMIT` that follows either, so on ClickHouse, and on a connection
whose dialect could not be probed, a statement that ends in one or both (in
either order) gets the header's `LIMIT` inserted in front of the first of
them, after any `LIMIT n BY`. A column, sort key or table named `format` or
`settings` (`ORDER BY format DESC`, `FROM format f`) is not taken for either
clause. As with a locking clause, one that sits behind a `#` on the same line
is left alone and the line reads `no limit applied`: ClickHouse can read `#`
as the start of a comment too.

When the returned count equals an applied limit, a badge reads `Limit
reached — more rows may exist`, because a full page is not evidence the
result ended there.

Above the app's limit sits the node's own `max_execute_rows` cap. A
statement that exceeds it fails rather than returning a truncated answer,
and the banner adds `The node caps results at N rows; choose a lower limit
or add LIMIT.` Choosing **All** says so before anything runs: `All asks for
every row. The node refuses results over its cap (25,000 unless the pipeline
sets max_execute_rows) and may be slow.`

### Confirmations

Each saved connection has a **safety level**, set in its connection editor
under **Safety level for this connection**:

- **Don't ask**: every statement runs as typed.
- **Ask before risky writes** (the default): asks before `UPDATE` or
  `DELETE` with no `WHERE`, an `UPDATE` or `DELETE` inside a `WITH` clause,
  `TRUNCATE`, `DROP` and `ALTER`, and before an `EXPLAIN ANALYZE` of
  anything but a read.
- **Ask before every write**: asks before anything that is not a read.
  Reads are `SELECT` (a `WITH … SELECT` included), `EXPLAIN`, `SHOW` and
  `DESCRIBE`. Everything else asks: `INSERT`, a bounded `UPDATE` or
  `DELETE`, `MERGE`, `SELECT … INTO`, `CREATE`, and also `CALL`, `GRANT`,
  `SET`, `DO` and `VALUES`, because a procedure can change rows and the app
  cannot tell. `EXPLAIN ANALYZE` counts as the statement it runs.

A write made inside a function or procedure is not seen at **Ask before
risky writes**: `SELECT my_fn()`, `DO`, `CALL` and `COPY … PROGRAM` run
without asking there, whatever they change. And a `SELECT` that calls a
function counts as a read even at **Ask before every write**, so a function
that writes (`SELECT pg_terminate_backend(…)`, `SELECT nextval('s')`) never
asks.

The level is stored on the saved connection, in the same per-user file on
the server as the connection itself, so it is the same in the app and as a
dev tool. A connection saved before levels existed reads as **Ask before
risky writes**. The line under the editor names the level, so it is never
invisible. The dialog has no answer that turns asking off; change the level
in the connection editor instead.

The dialog says what the statement does, quotes it, and says how it runs
(at once, committing on its own) and why it asked: `<connection> is set to
ask before risky writes. This is a check on the statement text, not a
database permission.` For a statement that changes rows it adds **Rows that
change**: `about N rows (planner estimate)` on PostgreSQL and MySQL, from a
plain `EXPLAIN` (no `ANALYZE`, so nothing runs) of the statement. It reads
`Estimating…` while that runs, and `No estimate` on ClickHouse, for a `WITH`
chain, or when the plan gives no number; for `TRUNCATE` it reads `Every
row`. Once an `UPDATE` or `DELETE` has an estimate, the title and the button
name the rows: `Update about 20 rows in orders?` and **Update 20 rows**.
**Cancel** works at any time, also while the estimate is still running. The
estimate is not recorded in History.

Until the connection's dialect is known (the schema is still being read), a
statement is read with each engine's comment rules: `#` starts a comment on
MySQL and ClickHouse, and `/*! … */` is code on MySQL. It asks if any of
those readings says it should, so `# note` on the line above a `DELETE`
cannot hide it.

`DROP` and `TRUNCATE` ask for the name to be typed: `Type orders to
confirm`. The name is the object's own name as the statement spells it,
without quotes or schema (`DROP TABLE "public"."Order Items"` asks for
`Order Items`). The match is exact: it is case-sensitive and nothing is
trimmed. The confirm button stays disabled until the text matches, and
Enter confirms only then. A statement with several targets (`DROP TABLE a,
b`), or one whose name the app cannot read (`DROP FUNCTION f(int)`), asks
for the verb instead: `DROP` or `TRUNCATE`.

A statement that begins with `WITH` is checked on the verb the chain
carries: `WITH audit AS (SELECT id FROM orders) DELETE FROM orders` deletes
every row and is asked about like any other `DELETE` with no `WHERE`. A
`WITH` clause whose body LEADS with `UPDATE` or `DELETE` — even behind a
read-only `WITH` chain of its own — is reported as `UPDATE inside a WITH
clause` or `DELETE inside a WITH clause` instead, with no verdict on its
`WHERE`, because the text check cannot tell what a `WHERE` inside the clause
applies to. When both apply, the outer statement is the one named.

The verb has to be the statement's own, not a word inside one of its
clauses: `SELECT ... FOR UPDATE` locks rows, and an upsert's `ON CONFLICT
... DO UPDATE` belongs to its `INSERT`, so neither is a risky write.

`EXPLAIN ANALYZE` runs the statement it describes rather than only planning
it, so it is checked as that statement: `EXPLAIN ANALYZE DELETE FROM orders`
is asked about like the `DELETE` it would run. Because an `EXPLAIN` reads
like a plan, both asking levels also ask before one that runs anything but a
read, even when that statement alone would not ask: `EXPLAIN ANALYZE DELETE
FROM orders WHERE id = 7` deletes the row. The same goes for every spelling
of it: PostgreSQL's `ANALYSE` and option lists (`EXPLAIN (ANALYZE)`,
`EXPLAIN (ANALYZE true, BUFFERS)`), and MySQL's `DESCRIBE ANALYZE` and `DESC
ANALYZE`. A plain `EXPLAIN`, `DESCRIBE` or `DESC` runs nothing and is never
asked about.

Read "a check on the statement text" literally. It never consults the
database for permission, does not know what a `WHERE` clause actually
matches, and prevents nothing; the node's `allow_execute` switch is the
real gate. It is not called a safe mode anywhere.

### When a statement fails

The banner leads with the database's own first line, prefixed `Database
reported: `. Any wrapper the node puts around that line is left out of the
headline, so what follows `Database reported: ` is the database speaking; a
collapsible **Database said** block holds the message verbatim, exactly as
it reached the app. It also names the statement, its lines, and which
earlier statements already ran or committed.

Whether the driver text arrives at all depends on the node version. Older
nodes swallow the database's message and return a generic string; in that
case the banner says so instead of inventing detail: `The database's message
was not returned by this node version. The pipeline node's log has it.` The
message is in the pipeline node's log either way.

### Stop waiting

Nothing in the tool protocol cancels a running statement. A second after a
statement reaches the database a **Stop waiting** button appears, and it
does exactly what it says: the app stops listening and discards the late
answer.

It is not offered while a confirmation is still open, because nothing has
been sent yet. In a run of several statements the second is counted from the
first one dispatched, so the button stays available for the rest of an
uninterrupted run; a confirmation between statements takes it away until the
next statement is sent.

The banner is explicit — `Stopped waiting after N.N s. The statement may
still be running on the database; this tool cannot cancel it.` To stop it,
stop it on the database.

A read you stopped waiting for, or a plan or a table page you navigated
away from, is not sent again and its answer is not shown. Closing the query
tab or switching away from the app during a run also ends the run: nothing
after the statement already sent goes out, and that statement's result is
neither shown nor added to History. As a dev tool the document stops
listening the same way, but a read already handed to the connection's engine
can still take its one retry there, because nothing reaches back to cancel
it.

### Autocomplete

Suggestions come from the schema snapshot: columns of the aliased or named
table after a `.`, table names after `FROM` / `JOIN` / `UPDATE` / `INTO`,
then columns of any table mentioned in the buffer, then keyword snippets
(`SELECT … FROM`, `JOIN … ON`, `INSERT … VALUES`, `UPDATE … SET … WHERE`,
`CREATE TABLE`, `EXPLAIN`). Identifiers are quoted per dialect. A table
created since the task started is not in the snapshot, so it is not
suggested.

## Results

Columns are typed, and the header tooltip says on what basis. When the app
can name the single source table and every returned column belongs to it,
the type comes from the schema and reads `BIGINT (schema)`; otherwise it is
inferred from the returned values and reads `number (inferred from N rows)`.
Numbers are right-aligned and sort numerically; leading-zero strings stay
strings. Selecting a row opens a cell inspector with every column's full
value, so a long JSON document is readable without widening the grid. The
inspector lists the columns of the statement whose result is shown, in the
order that statement returned them.

**Export** on the results card offers **Download CSV**, **Download JSON**
and **Copy as Markdown**, for the rows the statement returned under whatever
limit was applied. In CSV a NULL is an empty field and an empty string is
`""`, and objects are written as JSON text. A spreadsheet runs a CSV cell
that starts with a formula character, and results can hold text anyone
typed, so in CSV, text that starts with `=`, `+`, `-` or `@` (or a tab or a
carriage return) gets a leading `'`. Numbers keep their sign, and JSON and
Markdown keep the text as it is. In VS Code, which does not allow downloads
from a tool panel, CSV and JSON are copied to the clipboard instead, and the
menu says **Copy as CSV** and **Copy as JSON**. Elsewhere the app announces
that the download started; a browser that blocks it quietly cannot be told
apart.

A precision note shows under a result when a value may not be the number the
database holds: `Decimal values arrive as floating point; integers above
2^53 lose precision.` It shows for a float with more than 15 significant
digits, an integer beyond ±2^53, or a column the schema types as `DECIMAL`
or `NUMERIC`. That is the node's value conversion rather than the grid's
rendering, so it applies to exports too. Only a result whose single source
table is known gets its types from the schema, so a `NUMERIC` column in a
join shows the note only when one of its values is long enough to give it
away.

Rows arrive as objects keyed by column name, so two columns with the same
name merge into one. When a statement projects `*` over a join, or names the
same output column twice, the results say `Columns with the same name are
merged; alias them`. The check reads the text and is deliberately narrow: an
unaliased expression (`count(*)` twice) is not caught.

## Query history

The history drawer lists what you ran on this connection, newest first, with
search and filters for reads, writes, errors and pins. Each row is named by
the statement's first line of code: leading comments are skipped (`--` and
`/* */` everywhere, `#` on MySQL and ClickHouse), so a generated preview is
named by its `SELECT`, not by `-- Generated preview`. A statement that is
only a comment keeps its first line. Expanding an entry shows the full
statement, its outcome and its round trip, and lets you load it into the
editor, run it again, pin it, annotate it or delete it.

**Where it is stored matters.** In the app, history goes to your RocketRide
workspace preferences on the server, per user, not into the browser, and the
drawer says so whenever it is open: `Saved in your RocketRide workspace file
on the server, not in this browser. Statements are stored as typed, including
literal values.` As a dev tool it goes to a history file in your user
storage on the server instead (see [As a dev tool](#as-a-dev-tool)), and the
drawer says that. A literal typed into a `WHERE` clause is stored as typed.
A failed statement is stored with its failure message as that message
reached the app — the node's own wrapper included, not just the sentence
the banner quotes — and such a message can carry a value from the
statement. Both stay in the preferences file until the entry is deleted,
the list is cleared, or the bounds below trim it. It is not a server audit
log, and not a place for secrets.

History belongs to the account that ran it. When you sign out, or another
account signs in, the app forgets the history it was holding before it shows
anything for the next account. As a dev tool, each account has its own
section of the history file. In the app, the shell reads your workspace
preferences once per page and keeps them until the page reloads, so after
another account signs in without a reload the app shows that account no
history, records none of its statements, and saves nothing to the workspace
preferences (no history, saved query, grid layout or drawer width) until the
page is reloaded. The History drawer says `Signed in as a different account:
reload the page to see your history.` A setting the shell itself saves in
that time, such as a theme change, still writes the preferences it holds,
the first account's history among them, into the signed-in account's file,
so reload the page before working as another account.

The list is bounded, because the preferences file is read and written on
every app switch: 100 entries per connection including pinned ones, 8 KB per
statement, 256 KB across all connections. Recording can be turned off per
connection, and **Clear** empties one connection's list, pins included.

Re-running an entry that changed data asks first and quotes what it did last
time, whatever the connection's safety level; the rerun is a fresh run with
its own entry, and the safety level can ask again before it is sent.

## Saved queries

A statement you want to keep can be saved under a name, for one connection.
**Save as query** sits in the query header, for the editor's text, and on
every History entry, for that statement; the name starts as the statement's
leading `--` comment or its first line. **Saved**, also in the query header,
opens the connection's saved queries, where you can search, open, rename and
delete them. **Open** puts the statement into a new query and runs nothing:
it waits there for Run.

A saved query keeps the statement's text as typed, literal values included,
never its results. Where it is kept follows the mount, and the drawer says
which. In the app it goes to your RocketRide workspace preferences on the
server, per account, not into the browser. As a dev tool it goes to
`.workspace/rocketride.sql.queries.json` in your user storage on the server,
beside the history file, one section per signed-in account. As with
history, the dev tool reads that file before it shows or changes anything,
never writes a file it could not read (saved queries are then kept for that
session only), and two windows that change saved queries at the same time
each write the file from what they read, so the last one to save wins.
Saved queries belong to the account that saved them, and signing out, or
another account signing in, stops showing them at once. As a dev tool, each
account has its own section of the file, so one account's saved queries are
never shown to or written for another. In the app, which reads your
workspace preferences once per page, another account signing in without a
reload sees no saved queries and can save none until the page is reloaded;
the drawer says `Signed in as a different account: reload the page to see
your saved queries.` What the shell itself may still save in that time is
under [Query history](#query-history).

Change saved queries in one window at a time: if two windows change them,
the one that saves last overwrites the other's change.

Saving refuses rather than drops. A connection keeps up to 50 saved
queries; a saved query holds up to 16,384 characters of statement and 120 of
name; and all saved queries together stay within 256 KB. A save past one of
these says which and saves nothing, and nothing already saved is removed to
make room.

## Ask

**Ask**, above the query editor, turns a question in plain words into SQL
for you to review. It sends the question to the database node's `get_sql`
tool, which needs an LLM connected to that node in its pipeline. The node's
LLM writes the query, the node checks it with `EXPLAIN` (which does not run
it), and the SQL comes back unexecuted. It opens in a new query under the
editor's `Generated preview: review, then Run` banner, with your question as
a comment above it. Nothing runs until you press Run.

What goes to the model: your question; the node's schema as the node
reflects it (table and column names, their types, primary and foreign
keys); and the database description set on the node, if any. No rows are
sent. When the database rejects a draft, its error message goes back to the
model for another try, up to the node's validation attempts (five by
default). The bar says this too.

When the node does not return SQL, the bar shows the node's own words: its
refusal, the database's error, the model's answer when the question is not
one for the database, or that no LLM is connected to the node. The node's
safety check refuses queries that start with `WITH`: it returns only
statements that start with `SELECT` or `EXPLAIN`. A direct connection's
pipeline holds just the database node, so it has no LLM: there the bar is
disabled and says `Ask needs a pipeline whose database node has an LLM
connected.` Ask waits up to 120 seconds for the node's answer.

## Relationships

The table record drawer shows the table's columns, primary key and declared
foreign keys, and adds a marker such as `→ customers.customer_id` beside each
column that is part of one. It offers **Open data**, **Design**, **Copy
name** and **Copy SELECT**, and adds:

- **Referenced by (n)** — the tables whose foreign keys point at this one,
  each opening its own drawer.
- **Query** — **Select top 100** and **Count rows**, which open a new query
  document with the statement written and nothing run.
- **Join path** — pick a second table and the app walks the declared foreign
  keys for the shortest paths, up to four joins. Where several equally short
  paths exist, or two tables are joined by more than one key, it lists them
  all rather than picking one silently; composite keys produce a
  multi-column `ON`.

Only **declared** foreign keys are used, anywhere: in the drawer, in join
generation and in the review rules. Two columns that look related because of
their names are not treated as related. ClickHouse declares no foreign keys
at all, so these sections say `ClickHouse declares no foreign keys; join
paths are unavailable.`

The **Diagram** page shows the same declared relations as a graph. Clicking a
table node opens that table's Data page, and the minimap follows the theme.
While the schema is being read the page says `Reading the schema…`; if the
read fails it says `Could not read the schema` and offers Retry.

**Open as query** writes the join into a new query document. Generated SQL
is never run for you: the document opens under the banner `Generated preview:
review, then Run`, and the statement carries `-- generated from declared
foreign keys; review before running`. The banner clears on your first edit
or run.

## Insights

The Insights page orients you in an unfamiliar schema and reviews it. It
reads the snapshot only, queries nothing and changes nothing, so it works on
a connection where execution is off. The orientation strip names hubs (the
most-referenced tables, with their inbound count), leaves (tables that only
reference others) and isolated tables; every name opens that table's drawer.

Three rules produce findings:

| Rule | What it reports |
| --- | --- |
| R1 | The table has no primary key, so rows cannot be addressed individually and the data browser cannot page in a guaranteed order. |
| R2 | The two sides of a foreign key spell their type differently. Informational — the comparison is textual after normalisation, and the engine may accept both. |
| R3 | A foreign key names a table or column that is not in this snapshot. |

The limitations footer is the scope of every claim on the page: the rules
read columns, primary keys and declared foreign keys and nothing else.
Indexes, other constraints and the data are not inspected, and a finding is
a reading of one snapshot rather than a verdict on the database.

## Query plans

The plan drawer (**Explain**, or `Ctrl/Cmd+Shift+E`) runs a plain `EXPLAIN`
for the same statement Run would send, including any limit the header
applied. The form is per dialect: `EXPLAIN FORMAT=JSON` on MySQL, `EXPLAIN
(FORMAT JSON)` on PostgreSQL, plain `EXPLAIN` on ClickHouse. On any other
dialect the drawer says `EXPLAIN is not available for <dialect> in SQL
Explorer`.

**The raw output is the default view**, because it is what the database
actually sent; an interpreted tree sits beside it as a second tab. A plan
shape the parser does not recognise is an informational note next to the raw
text — `Could not interpret this plan shape; raw output shown` — never an
error, because nothing went wrong on the database's side.

Every number in the tree is a planner estimate. Plain `EXPLAIN` does not run
the statement, so nothing on this page was measured; numbers are suffixed
`est.` under the legend `Planner estimates, not measurements.` There is no
`EXPLAIN ANALYZE`. The parsers are tested against recorded fixtures rather
than a live database.

## Changing a table

The table designer stages changes rather than applying them as you type: you
edit columns, keys and types, and the view keeps a plan and shows the exact
DDL it will run. Nothing reaches the database until you apply.

The Apply confirmation names how many statements will run, lists the inbound
foreign keys that reference any column you are dropping, renaming or
retyping (`from schema snapshot HH:MM`), and carries the dialect's commit
note. Those notes never say "rollback", because nothing here rolls back:

- **MySQL** — each DDL statement commits implicitly. A failure mid-plan
  leaves earlier statements applied. Nothing here can be rolled back.
- **PostgreSQL** — each statement runs in its own autocommit transaction. A
  failure mid-plan leaves earlier statements applied.
- **ClickHouse** — some `ALTER` forms run as asynchronous mutations and may
  finish after the dialog closes.

A batch that stops part-way reports what committed, which statement failed
and what was not run, and the plan keeps the remaining statements.

**After a successful apply**, what the app can tell you depends on the node.
When the node offers a `refresh_schema` tool, the app re-reads the schema
and says `Applied HH:MM · schema re-read from the database.` When it does
not, the snapshot is still the one taken at task start, and the banner says
so: `Applied HH:MM. The node reflected its schema at task start; the tree
and diagram will not show this change until the pipeline restarts.` The
statements ran either way; only the app's picture of the schema is behind.

## As a dev tool

As a dev tool, SQL Explorer is split in two. The sidebar is the connection
list and holds the tool's one connection to the RocketRide engine; each
saved connection (and the connection editor) opens as its own document, and
a document reaches the engine only through the sidebar. The generic document
with no connection says how to open one. The same features are there, with
these differences:

- **History lives in a file.** The tool keeps query history in
  `.workspace/rocketride.sql.history.json` in your user storage on the server,
  beside the saved connections, one section per signed-in account. It is read
  before anything is recorded, so it is never overwritten by an empty list,
  and writes are batched. If the file exists but cannot be read, history is
  kept for that session only and nothing is written to it. Two windows that
  change history at the same time each write the file from what they read, so
  the last one to save wins. The drawer's privacy line says which of these
  applies. The sidebar forgets one account's history as soon as you sign out
  or another account signs in, before the next account's section is read.
  What survives a change:
  - **Sign-out, the connection drops, or the organization changes:** the
    last unsaved statements are held, and nothing is written while nobody is
    signed in. They are written when the same account is known again while
    the sidebar is open. They are dropped if the sidebar closes while nobody
    is signed in (in VS Code it closes when the connection drops).
  - **Another account signs in** (or the organization or team changes): the
    previous account's last unsaved statements are dropped. They are never
    written into another account's file.
  - **A statement run while the history file is still being read** (just
    after the sidebar opens or an account signs in) is saved once the read
    ends; if the account changes or the sidebar closes before that, it is
    lost.
  - **More than 128 history views open at once:** the oldest views stop
    updating until they are opened again.
- **The safety level is the connection's.** It is stored on the saved
  connection, not in preferences, so it is the same as in the app (see
  [Confirmations](#confirmations)). A dev tool is given no workspace
  preferences of its own.
- **The connection is the sidebar's.** When the engine connection drops, run
  and apply are disabled in every document, and a statement that was waiting
  is reported as possibly still running (there is no way to cancel it). An
  action taken while the connection is down is not sent at all. The sidebar
  reads nothing from the engine (your saved connections, your history file,
  the running pipelines) until it is opened: when you select the tool, or
  when a document needs it. A document restored before the SQL Explorer
  sidebar was opened asks the host to open the sidebar for it, and says
  "Starting SQL Explorer…" meanwhile. Only if no sidebar answers within a few
  seconds does it ask you to open it. A document that is already open stays
  open, with run and apply disabled, while the sidebar is closed. While
  nobody is signed in, a document says it is waiting for sign-in. With
  several hundred saved connections, the sidebar shares only part of the
  list with documents, and a document asks the sidebar for its own
  connection when it is not in that part.
- **Grid layouts are kept for the session.** In a dev tool, a grid's sort,
  column widths and page size are kept in memory: in rocket-ui until the
  page reloads, in VS Code until the document's panel closes. They are
  never written into the host's own preferences (the full app keeps them in
  its workspace preferences).
- **Account changes close documents.** A document opened under one account
  closes itself when another account signs in, and forgets the schema it was
  showing; while nobody can be vouched for (signed out, connection dropped) it
  only forgets the schema, and it opens or reads nothing on its own until an
  account is signed in again.
- **Engine error codes.** In VS Code the engine's error codes do not reach
  the tool, so a statement refused while its pipeline restarts is not sent
  again (see [Each statement commits on its own](#each-statement-commits-on-its-own));
  the refusal is shown as the engine worded it.
- **Waits are explicit.** Every request to the engine names how long it may
  take (see [Limits](#limits)); a document waits a little longer than the
  sidebar, so the sidebar's own answer arrives first. A statement on a node
  that publishes no deadline is waited for up to 24 hours (the longest wait
  the tool sets on any request), or twice that when a read is sent again
  after its pipeline restarted, plus the few minutes it may take to reach
  the connection, after which the document stops waiting; the statement
  itself is not stopped.

## Limits

- **No cancel.** **Stop waiting** stops the app waiting, not the database.
- **No client timeout on a statement** unless the node publishes a statement
  deadline: today's SQL nodes publish none and the engine sets none, so a
  long query is allowed to run until you stop waiting. Reading the schema
  waits up to 60 seconds, re-reading it 135, and the engine check 15.
- **No transactions.** Every statement commits on its own, and transaction
  control is refused.
- **No `EXPLAIN ANALYZE`.** Plan numbers are estimates, never measurements.
- **No `DELIMITER`.** Buffers that change the terminator split wrongly.
- **Declared foreign keys only.** Nothing is inferred from column names, and
  ClickHouse declares no foreign keys at all.
- **The schema is a snapshot** from pipeline start, unless the node can
  re-read it.
- **A pipeline-bound connection needs its pipeline running.** Discovery sees
  running tasks only; when the pipeline stops, the connection stops with it.
  A direct connection has no such dependency — its temporary pipeline is the
  app's to start and stop.
- **Direct connections store their configuration as typed** in your per-user
  server file. Use `${ROCKETRIDE_*}` references for secrets.
- **A direct connection's new settings apply once its pipeline restarts.**
  Editing its configuration (host, database, credentials) without changing
  its engine leaves the temporary pipeline already running with the
  settings it started with, until every document of the connection is
  closed or the pipeline idles out (15 minutes); the next document then
  starts it with the new settings. Changing the engine starts a new
  pipeline right away.
- **The limit moves in front of a locking clause.** MySQL requires the
  locking clause after `LIMIT`; PostgreSQL accepts either order; the app
  inserts its `LIMIT` before a trailing locking clause so the read stays
  bounded and valid on both. `SELECT … FOR UPDATE` is therefore sent as
  `SELECT …` / `LIMIT 200` / `FOR UPDATE`. Two shapes keep no limit at
  all — a locking clause OR the statement's own limit clause behind a `#`
  on the same line (sent untouched) and a `WITH` chain containing `FOR
  UPDATE` or `FOR NO KEY UPDATE` (classified as a write) — and a third
  keeps the old appended placement: a locking clause trailed by the
  statement's own `OFFSET`, where the `LIMIT` is appended after `OFFSET`
  rather than inserted before the clause.
- **The limit moves in front of ClickHouse's `SETTINGS` and `FORMAT`.** On
  ClickHouse, and on a connection whose dialect could not be probed,
  `SELECT … SETTINGS max_threads = 4` is sent as `SELECT …` / `LIMIT 200` /
  `SETTINGS max_threads = 4`. Such a clause behind a `#` on the same line
  keeps no limit (sent untouched).
- **A pipeline connection opens your own development run.** A team
  deployment of the same pipeline cannot be saved or opened as a connection.
- **Duplicate column names collapse.** A projection that returns two columns
  with the same name shows one: the node hands back each row as an object
  keyed by column name, and the grid takes its headers from the first row.
  Alias one of them to see both.
- **Tables from the connection's default schema only.** The reflection reads
  one schema, so tables in other schemas, and views, do not appear in the
  Overview, the Diagram or the editor's autocomplete.

## Next steps

- [`db_mysql`](../../nodes/src/nodes/db_mysql/README.md), [`db_postgres`](../../nodes/src/nodes/db_postgres/README.md)
  (including its [Supabase preset](../../nodes/src/nodes/db_postgres/README.md#supabase-preset), provider `db_supabase`),
  [`db_clickhouse`](../../nodes/src/nodes/db_clickhouse/README.md) and
  [`rocketride_sql`](../../nodes/src/nodes/rocketride_sql/README.md): the nodes behind every
  connection, including the tool surface and the direct-execution setting.
- [Apps](../../docs/public/product/concepts/apps.md): what an app is and how it reaches your engine.
- [Shell API](../../docs/public/product/guides/apps/index.md): the framework SQL Explorer is built on, when
  you want to build one of your own.
