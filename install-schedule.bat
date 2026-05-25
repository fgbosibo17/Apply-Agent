@echo off
REM ============================================================
REM  One-time setup: registers the job agent schedule in Windows
REM  Task Scheduler. Run this ONCE to install. After that, the
REM  scheduled task lives in Task Scheduler and fires daily.
REM
REM  Auto-detects its own folder so it works on any user's machine.
REM
REM  Usage: right-click → "Run as administrator" (admin required
REM         because of the wake-the-PC capability).
REM ============================================================

set "TASK_NAME=JobApplicationAgent"
set "PROJECT_DIR=%~dp0"
set "PROJECT_DIR=%PROJECT_DIR:~0,-1%"
set "XML_TEMPLATE=%PROJECT_DIR%\job-agent-schedule.xml"
set "XML_FILLED=%PROJECT_DIR%\job-agent-schedule.generated.xml"
set "BAT_PATH=%PROJECT_DIR%\run-job-agent.bat"

echo Installing scheduled task "%TASK_NAME%" ...
echo Project dir: %PROJECT_DIR%
echo Launcher:    %BAT_PATH%
echo Schedule:    weekdays at 9:00 AM local time
echo Wakes PC:    YES
echo Max runtime: 4 hours
echo.

if not exist "%XML_TEMPLATE%" (
    echo ERROR: job-agent-schedule.xml not found in %PROJECT_DIR%
    pause
    exit /b 1
)

if not exist "%BAT_PATH%" (
    echo ERROR: run-job-agent.bat not found in %PROJECT_DIR%
    pause
    exit /b 1
)

REM Substitute the absolute project path into the XML template
REM (the XML's <Command> and <WorkingDirectory> need full paths)
powershell -NoProfile -Command "(Get-Content -LiteralPath '%XML_TEMPLATE%' -Raw) -replace '__PROJECT_DIR__', '%PROJECT_DIR%' -replace '__BAT_PATH__', '%BAT_PATH%' | Set-Content -LiteralPath '%XML_FILLED%' -Encoding Unicode"

if errorlevel 1 (
    echo ERROR: failed to generate task XML from template.
    pause
    exit /b 1
)

REM Delete any existing copy first so re-running this is idempotent
schtasks /delete /tn "%TASK_NAME%" /f >nul 2>&1

REM Register the task
schtasks /create /tn "%TASK_NAME%" /xml "%XML_FILLED%"

if errorlevel 1 (
    echo.
    echo *** INSTALL FAILED. ***
    echo Common causes:
    echo  - Task Scheduler service is disabled
    echo  - You need Administrator rights to register a wake-the-PC task
    echo    ^(right-click this .bat and "Run as administrator"^)
    pause
    exit /b 1
)

REM Clean up the generated file (it's now registered in Task Scheduler)
del "%XML_FILLED%" >nul 2>&1

echo.
echo *** Schedule installed successfully. ***
echo.
echo Next run:  tomorrow at 9:00 AM (or first weekday morning).
echo View it:   Open "Task Scheduler" - look for "JobApplicationAgent"
echo Run now:   schtasks /run /tn "%TASK_NAME%"
echo Disable:   schtasks /change /tn "%TASK_NAME%" /disable
echo Enable:    schtasks /change /tn "%TASK_NAME%" /enable
echo Uninstall: double-click uninstall-schedule.bat
echo.
pause
