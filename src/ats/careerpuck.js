// CareerPuck handler — CareerPuck (app.careerpuck.com) is Greenhouse's
// candidate-facing SPA. The job is a normal Greenhouse job, and the classic
// Greenhouse embed form renders the real, fillable form for it. So we just
// redirect to the embed URL and delegate to the Greenhouse handler (which
// handles the careerpuck→embed redirect itself).
const { applyGreenhouse } = require('./greenhouse');

async function applyCareerpuck(page, jobMeta) {
  const url = page.url();
  const m = url.match(/careerpuck\.com\/job-board\/([^/]+)\/job\/(\d+)/);
  if (m) {
    await page.goto(`https://boards.greenhouse.io/embed/job_app?for=${m[1]}&token=${m[2]}`, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
    await page.waitForTimeout(1200);
  }
  return applyGreenhouse(page, jobMeta);
}

module.exports = { applyCareerpuck };
