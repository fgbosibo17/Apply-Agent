@echo off
rem Windows Task Scheduler entry point: the QA-style batch loop for one persona.
rem Edit PERSONA and TARGET; logs land in .state\runs\logs via src/run-loop.js.
cd /d "%~dp0"
set PERSONA=secondary
set COUNT_PERSONA=secondary
set TARGET=50
set BATCH=25
set MAX_EVAL=45
set BATCH_TIMEOUT_MS=1800000
node src/run-loop.js
