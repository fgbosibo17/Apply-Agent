// Answer bank for screening/essay questions (shared global).
// generateAnswer(question, p) → concise persona-tailored answer; generic fallback otherwise.
(function () {
  const PROFILE = {
    cloud: { stack: "AWS and Azure, Kubernetes (EKS/AKS), Terraform, and CI/CD pipelines", monitor: "Datadog, CloudWatch, Prometheus, Grafana, and Splunk", role: "Cloud Support / DevOps engineering" },
    fullstack: { stack: "React, Node.js, Python, and REST/real-time APIs", monitor: "Datadog, CloudWatch, and Grafana", role: "full-stack product engineering" },
    qa: { stack: "Playwright, Cypress, Selenium, REST Assured, and CI/CD quality gates", monitor: "Allure, Datadog, and Grafana", role: "QA automation / SDET" },
  };
  const pp = (p) => PROFILE[p.persona] || PROFILE.cloud;

  const CATS = [
    { re: /why\b.*\b(role|position|company|join|work here|team|interest|excit|draw|apply)|what (interests|excites|draws|motivates|appeals to) you|why (are you interested|do you want|this)/i,
      f: (p) => `I'm drawn to this ${pp(p).role} role because it lets me apply and deepen my work across ${pp(p).stack}. After ${p.totalYearsExperience}+ years, I want to keep compounding impact on a team that invests in ${p.persona === "qa" ? "quality engineering and shift-left testing" : p.persona === "fullstack" ? "product velocity and clean architecture" : "reliability and infrastructure as a product"}.` },
    { re: /(experience|familiar|proficien|worked).*(aws|azure|gcp|cloud)|cloud (platform|provider|experience)/i,
      f: (p) => `I've worked hands-on with AWS and Azure for ${p.totalYearsExperience}+ years — EC2/EKS, S3, RDS, IAM, VPC networking, CloudWatch, plus AKS, Entra ID, and Azure Monitor — across multi-account production environments, resolving scheduling, autoscaling, networking, and identity issues.` },
    { re: /(experience|familiar|proficien|worked).*(kubernetes|k8s|eks|aks|container|docker|helm)/i,
      f: () => `I operate Kubernetes in production on EKS and AKS — scheduling, autoscaling, ingress, and certificate management, deploying with Helm and Argo CD (GitOps) — and have debugged real cluster, networking, and resource-limit issues.` },
    { re: /(experience|familiar|proficien|worked).*(terraform|infrastructure as code|iac|cloudformation|ansible)/i,
      f: () => `Infrastructure as Code is core to how I work — reusable Terraform modules with remote state, plus Ansible and CloudFormation/Bicep. I've hardened client Terraform with input validation, module standards, and drift detection.` },
    { re: /(experience|familiar|proficien|worked).*(ci\/?cd|jenkins|github actions|gitlab|pipeline|continuous (integration|delivery|deployment))/i,
      f: () => `I build CI/CD pipelines in Jenkins, GitHub Actions, and GitLab CI — SonarQube quality gates, automated testing, containerized builds, blue/green and rollback deploys — cutting environment setup from days to under 30 minutes.` },
    { re: /(experience|familiar|proficien|worked).*(monitor|observ|datadog|prometheus|grafana|splunk|alert|on-?call|incident|pagerduty|sre|reliability)/i,
      f: (p) => `I run observability and incident response with ${pp(p).monitor} and PagerDuty — actionable dashboards, reduced alert noise, SLAs/SLOs, on-call triage, and post-incident reviews that turn outages into permanent fixes.` },
    { re: /(experience|familiar|proficien|worked).*(linux|rhel|ubuntu|centos|unix|bash|shell)/i,
      f: () => `Strong on Linux (RHEL, CentOS, Ubuntu) — permissions/sudoers, OS hardening, SSH key-only access, patching — and I automate the repetitive parts with Bash and Python.` },
    { re: /(experience|familiar|proficien|worked).*(python|scripting|automation|automate)/i,
      f: () => `I write Python and Bash automation to remove operational toil — patching, log rotation, backup verification, and support tasks — turning hours of manual work into reliable, repeatable processes.` },
    { re: /(describe|tell.*about|example|time when|challeng|difficult|hardest).*(incident|outage|production|problem|bug|troubleshoot|debug|conflict|project)/i,
      f: () => `In a 24x7 lending platform across AWS, COCC, and FIS, downtime blocked loan processing. I was the escalation point — reproducing issues, tracing root causes, remediating database problems, communicating status to resolution — and co-designed the monitoring/SLOs that cut root-cause isolation from hours to minutes.` },
    { re: /(greatest |biggest )?strength|what.*(good at|bring to|make you)|why should we (hire|consider)/i,
      f: () => `My strength is owning a problem from first ticket to root cause and keeping everyone informed. I fix root causes rather than symptoms, and I can explain a complex failure to engineers or executives equally well.` },
    { re: /(why|reason).*(leaving|leave|looking|change|new (role|opportunity)|move on)/i,
      f: () => `I'm looking to grow into a role with deeper ownership and broader scope where I can apply my reliability and automation experience at scale.` },
    { re: /tell (us|me) about (yourself|your background)|introduce yourself|your experience|summary/i,
      f: (p) => `${p.fullName}, ${p.currentTitle} with ${p.totalYearsExperience}+ years in ${pp(p).role}, hands-on across ${pp(p).stack}, with a root-cause-first approach and a track record of automating toil and keeping production reliable.` },
    { re: /(remote|distributed|work from home).*(experience|comfortable|productive)|how.*remote/i,
      f: () => `I've worked remotely in 24x7 distributed teams across US and international time zones, coordinating incident response over Slack/PagerDuty with strong written-communication habits and a reliable home office.` },
    { re: /(salary|compensation|pay).*(expect|require|range|desired)/i,
      f: (p) => p.salaryRangeString },
  ];
  const FALLBACK = (p) => `With ${p.totalYearsExperience}+ years in ${pp(p).role}, I bring hands-on depth across ${pp(p).stack}, a root-cause-first approach, and a track record of automating toil and keeping production reliable. Happy to go deeper on specifics in conversation.`;

  self.generateAnswer = function (question, p) {
    const q = (question || "").trim();
    if (!q) return null;
    for (const c of CATS) if (c.re.test(q)) return c.f(p);
    return FALLBACK(p);
  };
})();
