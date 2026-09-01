@echo off
cd /d C:\Users\fopef\OneDrive\Desktop\NewCode\QAJob
set PERSONA=qa
set COUNT_PERSONA=qa
set GOAL_DATE=2026-06-29
set TARGET=350
set BATCH=25
set MAX_EVAL=45
set BATCH_TIMEOUT_MS=1800000
set BATCH_PROFILE=browser-profile-qarun3
set SCRATCH=C:\Users\fopef\AppData\Local\Temp\claude\C--Users-fopef-OneDrive-Desktop-NewCode-QAJob\e1b5b06d-165d-4604-b0ad-a8812a4ce4bc\scratchpad
node src/run-loop.js >> "%SCRATCH%\qa-loop-scheduled.log" 2>&1
