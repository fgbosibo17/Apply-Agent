@echo off
REM ============================================================
REM  Job Application Agent — scheduled launcher
REM
REM  This .bat is invoked by Windows Task Scheduler on a cron.
REM  It launches Claude Code headlessly in this folder, runs the
REM  agent's autonomous workflow, and logs everything.
REM
REM  Auto-detects its own location — no hardcoded paths, so this
REM  works on any user's machine.
REM ============================================================

REM Project dir = the folder this .bat lives in
set "PROJECT_DIR=%~dp0"
set "PROJECT_DIR=%PROJECT_DIR:~0,-1%"
set "LOG_FILE=%PROJECT_DIR%\scheduled-runs.log"

REM Find the claude CLI (must be on PATH, or set CLAUDE_BIN below)
where claude >nul 2>&1
if %ERRORLEVEL%==0 (
    set "CLAUDE_BIN=claude"
) else if exist "%USERPROFILE%\.local\bin\claude.exe" (
    set "CLAUDE_BIN=%USERPROFILE%\.local\bin\claude.exe"
) else if exist "%LOCALAPPDATA%\claude\claude.exe" (
    set "CLAUDE_BIN=%LOCALAPPDATA%\claude\claude.exe"
) else (
    echo ERROR: claude CLI not found on PATH or at common install locations. >> "%LOG_FILE%"
    echo Install Claude Code and ensure 'claude' is on PATH, or edit this .bat >> "%LOG_FILE%"
    echo to point CLAUDE_BIN at the full path. >> "%LOG_FILE%"
    exit /b 1
)

cd /d "%PROJECT_DIR%"

echo. >> "%LOG_FILE%"
echo ============================================================ >> "%LOG_FILE%"
echo === Run started: %date% %time% >> "%LOG_FILE%"
echo === Project dir: %PROJECT_DIR% >> "%LOG_FILE%"
echo === Claude bin:  %CLAUDE_BIN% >> "%LOG_FILE%"
echo ============================================================ >> "%LOG_FILE%"

REM Invoke Claude Code in headless / non-interactive mode.
REM   -p                                = prompt mode (single autonomous run)
REM   --dangerously-skip-permissions    = don't prompt for tool approvals
REM                                       (safe here: project is trusted, MCP is local)
REM   --output-format text              = readable plain log output
REM
REM Edit the prompt below to change the per-run target without
REM touching Task Scheduler.

"%CLAUDE_BIN%" -p "Read CLAUDE.md SESSION CONFIG and APPLICATION ANSWERS at the top of the file. Then run a full autonomous job application session. Target: apply to 50 jobs today (overrides SESSION_TARGET for this run). Use the persistent browser at ./browser-profile and upload the resume named in RESUME_FILE. Cycle aggressively through Tier 1 ATS channels. Log everything to applications-log.csv and seen-jobs.csv. When done, print a session summary." --dangerously-skip-permissions --output-format text >> "%LOG_FILE%" 2>&1

echo. >> "%LOG_FILE%"
echo === Run finished: %date% %time% >> "%LOG_FILE%"
echo ============================================================ >> "%LOG_FILE%"

exit /b %ERRORLEVEL%
