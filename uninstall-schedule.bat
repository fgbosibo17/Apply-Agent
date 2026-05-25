@echo off
REM ============================================================
REM  Removes the JobApplicationAgent scheduled task.
REM  Run this if you want to stop the daily schedule entirely.
REM ============================================================

set "TASK_NAME=JobApplicationAgent"

echo Removing scheduled task "%TASK_NAME%" ...
schtasks /delete /tn "%TASK_NAME%" /f

if errorlevel 1 (
    echo.
    echo Task was not found or could not be removed.
) else (
    echo.
    echo *** Schedule removed. The daily run will no longer fire. ***
)

echo.
pause
