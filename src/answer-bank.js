// Claude-authored answer bank for ATS screening / essay questions.
// generateAnswer(question, a) keyword-matches a question to a concise, persona-
// tailored answer (a = the active persona's answers object). Falls back to a
// strong generic answer when no category matches. Keeps the apply pipeline
// autonomous (no API key) while still giving credible written responses.
//
// Answers are intentionally 2-4 sentences: long enough to be substantive,
// short enough to fit typical screening fields. They draw on the persona's
// resume facts (employer, title, years, tech stack) so they stay truthful.
//
// Matching order (most specific first):
//   1. SKILLS    — "experience with <specific tech>?" → a real answer about THAT tech
//   2. CATEGORIES— behavioral/motivational (why this role, strengths, etc.)
//   3. extraction fallback — echo the named skill from the question
//   4. GENERIC_FALLBACK
//
// ╔════════════════════════════════════════════════════════════════════════╗
// ║  CUSTOMIZE THIS FILE FOR YOUR BACKGROUND.                               ║
// ║  The STRUCTURE — specific-skill matching → a tailored answer, with a    ║
// ║  named-skill fallback — is what makes answers read like a real person   ║
// ║  instead of generic filler. The example content below is for tech /     ║
// ║  cloud / QA roles; edit the PROFILE stacks, the SKILLS regexes+answers,  ║
// ║  and the CATEGORIES to match YOUR field, tools, and accomplishments.    ║
// ║  Keep answers truthful to your resume.                                  ║
// ╚════════════════════════════════════════════════════════════════════════╝

// Talking points used to fill the templates. Key these to your persona names
// (see personas.js). `default` is the fallback for any persona not listed.
// EDIT the stacks/role to YOUR tools and field.
const PROFILE = {
  default: {
    stack: 'the core tools and technologies in my field',
    monitor: 'the standard tools and reporting in my field',
    role: 'my field',
  },
  // ── Example profiles (rename/replace with your personas) ──
  cloud: {
    stack: 'AWS and Azure, Kubernetes (EKS/AKS), Terraform, and CI/CD pipelines',
    monitor: 'Datadog, CloudWatch, Prometheus, Grafana, and Splunk',
    role: 'cloud support and DevOps engineering',
  },
  fullstack: {
    stack: 'React, Node.js, Python, and REST/real-time APIs',
    monitor: 'Datadog, CloudWatch, and Grafana',
    role: 'full-stack product engineering',
  },
  qa: {
    stack: 'Playwright, Cypress, Selenium, REST Assured, and CI/CD quality gates',
    monitor: 'Allure, Datadog, and Grafana',
    role: 'QA automation / SDET',
  },
};

function pp(a) { return PROFILE[a.persona] || PROFILE.default; }
function yrs(a) { return a.totalYearsExperience || 7; }

// ── SKILL-SPECIFIC answers (checked FIRST, before broad categories) ──────────
// Each entry answers a question about ONE specific technology/skill with content
// about THAT skill — never a generic "X years of DevOps" blurb. Grounded in the
// cloud-support/DevOps persona so answers stay truthful and consistent.
const SKILLS = [
  // ── QA-persona skills (test automation, BA/PO, release, integration, data,
  // LLM-eval). Keyword-gated, so they only fire on QA-relevant questions. ──
  { re: /\b(test automation|automated test|selenium|cypress|playwright|webdriver|appium|test framework|page object|e2e|end[- ]to[- ]end test|ui automation)\b/i,
    answer: (a) => `I build and own end-to-end test automation — Playwright, Cypress, and Selenium with the Page Object model, wired into CI so suites run on every PR. I've designed self-healing, data-driven frameworks, cut flaky tests, and shifted coverage left so defects are caught before release.` },
  { re: /\b(api testing|rest assured|postman|api automation|contract test|service test|soap ?ui|graphql test)\b/i,
    answer: (a) => `API testing is core to my work — REST Assured and Postman/Newman for functional, contract, and negative testing of REST/GraphQL services, run in CI. I validate schemas, status codes, auth, and edge cases, and I mock dependencies to test services in isolation.` },
  { re: /\b(performance test|load test|jmeter|\bk6\b|gatling|stress test|soak test|scalability test)\b/i,
    answer: (a) => `I run performance and load testing with JMeter and k6 — modeling realistic traffic, measuring latency/throughput percentiles, finding bottlenecks, and setting SLAs. I integrate these into CI so regressions in response time are caught early.` },
  { re: /\b(test plan|test case|test strategy|test management|testrail|zephyr|qase|defect|bug triage|qa process|test coverage|regression suite)\b/i,
    answer: (a) => `I own test strategy end-to-end — writing test plans and cases (TestRail/Zephyr), prioritizing risk-based coverage, running regression suites, and managing defects through triage to closure in Jira. I report quality metrics that give stakeholders a clear release-readiness picture.` },
  { re: /\b(requirement|user stor(y|ies)|acceptance criteria|business analy|\bbsa\b|stakeholder|backlog|use case|brd|functional spec|gap analysis|process mapping)\b/i,
    answer: (a) => `I translate business needs into clear, testable requirements — eliciting from stakeholders, writing user stories with acceptance criteria, and mapping current/future-state processes. My QA background means I write requirements that are unambiguous and verifiable, which cuts rework downstream.` },
  { re: /\b(product owner|product backlog|scrum|agile|kanban|sprint|prioriti|roadmap|grooming|refinement|ceremonies)\b/i,
    answer: (a) => `I work as a hands-on product/Agile partner — grooming and prioritizing the backlog, writing stories with clear acceptance criteria, and running sprint ceremonies. I balance stakeholder value against delivery risk and keep engineering and business aligned on what ships next.` },
  { re: /release manage|release coordinat|release train|change management|deployment|\bci\/?cd\b|\bcab\b|go[- ]live|rollback|cut[- ]?over|release notes|\bsox\b/i,
    answer: (a) => `I coordinate releases end-to-end — building release plans and runbooks, managing the change-approval (CAB) process, scheduling deployments and cutovers, and owning rollback criteria. I keep CI/CD pipelines and release notes tight so go-lives are predictable and auditable.` },
  { re: /\b(integration (engineer|test|specialist)|system integration|\bapi\b integration|middleware|\betl\b|data pipeline integration|webhook|edi\b|interface testing)\b/i,
    answer: (a) => `I design and validate integrations between systems — APIs, webhooks, middleware, and ETL/data flows — testing data integrity, error handling, and idempotency across the interface. I troubleshoot failures end-to-end, from payload and auth to downstream state.` },
  { re: /\b(implementation (consultant|specialist|manager)|onboarding|customer implementation|solution(s)? delivery|deployment (specialist|consultant)|configuration|client onboarding|saas implementation)\b/i,
    answer: (a) => `I lead customer implementations and solution delivery — scoping requirements, configuring the platform, validating data and integrations, and driving UAT to go-live. I partner with clients and engineering to deliver on time and make sure the solution actually works for the customer's workflow.` },
  { re: /\b(data quality|data validation|data integrity|data governance|etl test|data accuracy|data cleansing|data profiling|\bsql\b|data reconciliation)\b/i,
    answer: (a) => `I own data quality and validation — profiling datasets, writing SQL and automated checks for completeness, accuracy, and consistency, and reconciling source-to-target in ETL pipelines. I build data validation suites that catch corruption and drift before it reaches production or reports.` },
  { re: /\bllms?\b|large language model|model evaluat|prompt (engineer|evaluat)|\brlhf\b|annotation|ai (evaluat|quality|rater)|hallucinat|ground[- ]truth|red[- ]team|eval(uation)? harness|benchmark|fine[- ]tun/i,
    answer: (a) => `I build LLM evaluation harnesses — defining rubrics and ground-truth sets, scoring outputs for accuracy, relevance, safety, and hallucination, and running A/B and regression evals on prompt and model changes. I combine automated metrics with structured human review (RLHF-style) to keep quality measurable.` },

  // Identity & access management
  { re: /\b(iam|identity (and |& )?access|access management|rbac|abac|least[- ]privilege|\bsso\b|\bsaml\b|\boauth\b|\boidc\b|okta|entra|azure ad|active directory|\bldap\b|identity federation|privileged access|\bpam\b|kerberos)\b/i,
    answer: (a) => `I manage identity and access hands-on: AWS IAM roles, policies, and permission boundaries built around least privilege, plus Azure Entra ID (Azure AD), SSO/SAML/OIDC federation, and RBAC. Day to day I right-size and audit permissions, set up cross-account and federated access, and troubleshoot authentication and authorization failures in production.` },

  // Networking
  { re: /\b(networking|network|\bvpc\b|subnet|\bdns\b|load balanc|firewall|tcp\/?ip|\bvpn\b|route ?53|\bcdn\b|cloudfront|ingress|peering|nat gateway|security group|latency|packet)\b/i,
    answer: (a) => `Networking is a core part of my support work — VPCs, subnets, security groups, route tables, load balancers, DNS (Route 53), VPN/peering, NAT, and TLS. I spend a lot of time tracing connectivity, latency, and DNS issues end-to-end, from name resolution and firewall rules down to application ports.` },

  // Infrastructure as Code
  { re: /\b(terraform|infrastructure as code|\biac\b|cloudformation|\bbicep\b|pulumi|ansible|chef|puppet|configuration management)\b/i,
    answer: (a) => `Infrastructure as Code is how I work — reusable Terraform modules with remote state and drift detection, plus Ansible and CloudFormation/Bicep. I've hardened client Terraform codebases with input validation and module standards to eliminate recurring misconfiguration incidents.` },

  // Kubernetes / containers
  { re: /\b(kubernetes|k8s|eks|aks|gke|container|docker|helm|argo ?cd|openshift|pods?|service mesh|istio)\b/i,
    answer: (a) => `I run Kubernetes in production on EKS and AKS — scheduling, autoscaling, ingress, and certificate management, deploying with Helm and Argo CD (GitOps). I've debugged real cluster problems from pod scheduling and CrashLoopBackOff to networking and resource-limit issues.` },

  // CI/CD
  { re: /\b(ci\/?cd|jenkins|github actions|gitlab ?ci|circle ?ci|travis|pipeline|continuous (integration|delivery|deployment)|blue[- ]?green|canary|rollback)\b/i,
    answer: (a) => `I build and maintain CI/CD pipelines in Jenkins, GitHub Actions, and GitLab CI — with quality gates, automated tests, containerized builds, and blue/green and rollback strategies. Standardizing these pipelines cut environment setup from days to under 30 minutes on my team.` },

  // Monitoring / observability / on-call / SRE
  { re: /\b(monitor|observ|datadog|prometheus|grafana|splunk|new relic|cloudwatch|elk|kibana|alert|on-?call|incident|pagerduty|opsgenie|\bsre\b|reliability|\bslo\b|\bsla\b|\bslis?\b|mttr|postmortem|root cause)\b/i,
    answer: (a) => `I run observability and incident response with ${pp(a).monitor} and PagerDuty — building actionable dashboards, cutting alert noise, defining SLAs/SLOs, and leading on-call triage and blameless post-incident reviews that turn outages into permanent fixes.` },

  // Linux / OS
  { re: /\b(linux|rhel|ubuntu|centos|debian|unix|bash|shell script|systemd|cron|server administration|sysadmin)\b/i,
    answer: (a) => `I'm strong on Linux (RHEL, CentOS, Ubuntu) — users, permissions and sudoers policy, OS hardening, SSH key-only access, and patching — and I automate the repetitive parts with Bash and Python so systems stay stable, secure, and audit-ready.` },

  // Scripting / automation
  { re: /\b(python|powershell|scripting|automation|automate|boto3|\bgo\b|golang|ruby|perl)\b/i,
    answer: (a) => `I write Python, Bash, and PowerShell automation to remove recurring operational toil — patching, log rotation, backup verification, account provisioning, and support tasks. It's the through-line of my career: scripting that turns hours of manual work into reliable, repeatable processes.` },

  // Databases / SQL
  { re: /\b(sql|database|postgres|mysql|mssql|sql server|oracle|mongodb|dynamodb|redis|rds|query|stored procedure)\b/i,
    answer: (a) => `I work with relational and NoSQL databases — PostgreSQL, MySQL, SQL Server, and RDS, plus DynamoDB and Redis. I write SQL for investigation and reporting, troubleshoot slow queries and locking, and have remediated production database incidents on a 24x7 platform.` },

  // Security / compliance
  { re: /\b(security|compliance|soc ?2|hipaa|pci|gdpr|iso ?27001|vulnerab|encryption|secrets? manage|cspm|hardening|audit|zero trust|nist)\b/i,
    answer: (a) => `I treat security as part of operations — secrets management (Vault/KMS), encryption at rest and in transit, vulnerability remediation, OS and cloud hardening, and least-privilege access. I've supported SOC 2 and HIPAA-aligned environments and helped close audit findings.` },

  // Serverless / cloud-native
  { re: /\b(serverless|lambda|azure functions|step functions|api gateway|sqs|sns|event[- ]driven|fargate|app service)\b/i,
    answer: (a) => `I support serverless and managed workloads — AWS Lambda, API Gateway, SQS/SNS, Step Functions, and Fargate, plus Azure Functions/App Service. I help teams troubleshoot cold starts, timeouts, IAM permissions, and event wiring in event-driven architectures.` },

  // Cost / FinOps
  { re: /\b(cost optim|finops|billing|cost management|reserved instance|savings plan|right[- ]?sizing|cloud spend)\b/i,
    answer: (a) => `I've driven cloud cost optimization — right-sizing instances, cleaning up idle resources, applying Savings Plans/Reserved Instances, and building cost dashboards and tagging policies so teams can see and own their spend.` },

  // Cloud platforms (AWS / Azure / GCP) — GENERAL (after the specific cloud skills
  // above so "AWS IAM" → IAM answer, while bare "AWS"/"Azure" lands here).
  { re: /\b(aws|amazon web services|azure|microsoft azure|gcp|google cloud|cloud platform|multi-?cloud|cloud provider|ec2|s3)\b/i,
    answer: (a) => `I've worked hands-on with AWS and Azure for ${yrs(a)}+ years across multi-account production environments — EC2/EKS, S3, RDS, IAM, VPC networking, and CloudWatch on AWS, plus AKS, Entra ID, and Azure Monitor on Azure. Day to day I resolve compute, networking, scaling, and identity issues and tune monitoring and cost.` },

  // ── Customer / technical support & success (cloud persona also covers these) ──
  // Ticketing tools
  { re: /\b(zendesk|freshdesk|jira service|service ?now|intercom|salesforce service|kustomer|help ?scout|ticketing|help ?desk|service desk)\b/i,
    answer: (a) => `I've worked daily in ticketing and support platforms — Jira/Jira Service Management, ServiceNow, and Zendesk-style queues — triaging, prioritizing by severity/SLA, documenting clear reproduction steps and resolutions, and keeping customers updated until their issue is fully closed.` },

  // Technical support / troubleshooting
  { re: /\b(technical support|customer support|troubleshoot|tier ?[123]|t[123] support|diagnos|resolve.*(issue|ticket)|debugging customer|root cause)\b/i,
    answer: (a) => `Technical troubleshooting is the heart of what I do: I reproduce the issue, isolate root cause across application, infrastructure, and network layers, apply a fix or a clear workaround, and document it so it doesn't recur. I'm comfortable being the escalation point on a 24x7 platform and explaining the resolution in plain language.` },

  // Customer success / retention / onboarding
  { re: /\b(customer success|csm\b|retention|churn|renewal|upsell|cross[- ]sell|onboarding|implementation|adoption|account manage|customer (health|journey|relationship)|qbr|stakeholder)\b/i,
    answer: (a) => `I focus on customer outcomes — guiding onboarding and implementation, driving product adoption, monitoring account health, and getting ahead of churn risk with proactive check-ins and QBRs. I partner closely with engineering and product to turn customer feedback into fixes and keep renewals healthy.` },

  // SaaS / product knowledge
  { re: /\b(saas|software as a service|product knowledge|platform knowledge|api support|integration support|webhooks?)\b/i,
    answer: (a) => `I've supported SaaS platforms end-to-end — including API and integration support, webhooks, and authentication flows — so I can help customers from a first-line "how do I" question all the way to a deep technical integration issue.` },

  // Communication / documentation
  { re: /\b(communicat|written communication|documentation|knowledge base|\bkb\b|runbook|technical writing|articulate|explain)\b/i,
    answer: (a) => `Clear communication is a strength of mine — I write runbooks, knowledge-base articles, and post-incident summaries, and I'm comfortable translating a complex technical failure for both engineers and non-technical stakeholders. Good documentation is how I make a one-time fix scale to the whole team.` },

  // Leadership / mentoring
  { re: /\b(leadership|lead a team|mentor|coach|manage (a |the )?team|people management|team lead)\b/i,
    answer: (a) => `I've led by example and through mentoring — owning incidents end-to-end, setting on-call and documentation standards, and bringing newer engineers up to speed on the platform. I lead through clarity and follow-through rather than title.` },

  // Agile / ways of working
  { re: /\b(agile|scrum|kanban|sprint|ceremon|jira board|ways of working)\b/i,
    answer: (a) => `I work in Agile/Scrum and Kanban day to day — sprint planning, standups, and retros — and I use Jira to track work transparently. I keep a bias toward shipping small, well-tested changes and closing the loop with stakeholders.` },
];

// Category matchers (behavioral / motivational) → answer builder.
const CATEGORIES = [
  {
    re: /why.*(want|wish|interested|interest you|join|apply|excit|drawn|this (role|company|position|job|opportunity)|good fit|choose us|work (here|for|with))|what (interests|excites|draws|motivates) you|what (about|interests you about)/i,
    answer: (a) => a.whyThisRoleBlurb ||
      `I'm drawn to this role because it lets me own reliability and customer outcomes end-to-end. After ${yrs(a)}+ years in ${pp(a).role} across ${pp(a).stack}, I want to keep deepening that impact on a team that treats support and infrastructure as a product.`,
  },
  {
    re: /(greatest |biggest )?strength|what.*(good at|bring to|make you)|why should we (hire|consider)|what sets you apart|unique/i,
    answer: (a) => `My strength is owning a problem from the first ticket to root cause and keeping everyone informed along the way. I fix root causes rather than symptoms, and I'm equally comfortable explaining a complex failure to engineers or to executives.`,
  },
  {
    re: /(weakness|area.*(improv|develop|growth)|something you.*working on)/i,
    answer: (a) => `I've had to learn to delegate and trust process instead of personally chasing every incident. I've gotten better at it by investing in runbooks, dashboards, and mentoring so the whole team can resolve issues, not just me.`,
  },
  {
    re: /(describe|tell.*about|example|time when|situation where|challeng|difficult|hardest|proud).*(incident|outage|production|problem|bug|troubleshoot|debug|conflict|project|customer|deadline|achievement)/i,
    answer: (a) => `On a 24x7 production platform where downtime directly blocked the business, I was the escalation point — reproducing issues, tracing root causes, remediating the underlying problems, and communicating status to stakeholders until resolution — and I co-designed the monitoring and SLOs that cut root-cause isolation from hours to minutes. (← EXAMPLE: replace with your own story.)`,
  },
  {
    re: /(why|reason).*(leaving|leave|looking|change|new (role|opportunity)|move on)/i,
    answer: (a) => a.reasonForLeaving || `I'm looking to grow into a role with deeper ownership and broader scope where I can apply my reliability, automation, and customer-facing experience at scale.`,
  },
  {
    re: /tell (us|me) about (yourself|your background)|introduce yourself|walk.*through.*(background|resume)|^summary|your experience$/i,
    answer: (a) => a.elevatorPitch || GENERIC_FALLBACK(a),
  },
  {
    re: /(remote|distributed|work from home).*(experience|comfortable|productive)|how.*remote|work independently|self[- ]motivat/i,
    answer: (a) => `I've worked remotely in 24x7 distributed teams across US and international time zones, coordinating incident response over Slack/PagerDuty and collaborating async with engineering, product, and support. I have a reliable home office setup and strong written-communication habits.`,
  },
  {
    re: /(salary|compensation|pay).*(expect|require|range|desired)|expected (salary|compensation)/i,
    answer: (a) => a.salaryRangeString || `My target range is flexible based on the overall package and scope of the role.`,
  },
  {
    re: /(career|where.*see yourself|long[- ]term|5 years|goals)/i,
    answer: (a) => `Over the next few years I want to deepen my ownership of cloud reliability and customer outcomes — taking on broader scope, mentoring others, and helping a team scale its support and infrastructure practices. This role is a strong step on that path.`,
  },
];

const GENERIC_FALLBACK = (a) =>
  `With ${yrs(a)}+ years in ${pp(a).role}, I bring hands-on depth across ${pp(a).stack}, a root-cause-first approach to problem solving, and a track record of automating away toil while keeping customers and production systems running smoothly. I'd be glad to go deeper on any specifics in conversation.`;

// Pull the specific skill/topic a question is asking about, so even an unmapped
// question gets an on-topic answer that NAMES the thing instead of a generic blurb.
function extractSkill(q) {
  const m = q.match(/experience (?:with|in|using|of)\s+([a-z0-9 .,+/&#()-]{2,70})/i)
        || q.match(/familiar(?:ity)? with\s+([a-z0-9 .,+/&#()-]{2,70})/i)
        || q.match(/proficien\w*\s+(?:in|with)\s+([a-z0-9 .,+/&#()-]{2,70})/i)
        || q.match(/knowledge of\s+([a-z0-9 .,+/&#()-]{2,70})/i)
        || q.match(/worked? (?:with|on)\s+([a-z0-9 .,+/&#()-]{2,70})/i)
        || q.match(/comfortable (?:with|using)\s+([a-z0-9 .,+/&#()-]{2,70})/i);
  if (!m) return null;
  return m[1].replace(/[.?!,;:]+\s*$/, '').replace(/\s+/g, ' ').trim();
}

// Return a concise answer for a free-text question, or a strong fallback. Order:
// specific skill → behavioral category → named-skill extraction → generic.
function generateAnswer(question, a) {
  const q = (question || '').trim();
  if (!q) return null;
  for (const s of SKILLS) if (s.re.test(q)) return s.answer(a);
  for (const cat of CATEGORIES) if (cat.re.test(q)) return cat.answer(a);
  const skill = extractSkill(q);
  if (skill && skill.length <= 70) {
    return `Yes — I have hands-on experience with ${skill}. Across ${yrs(a)}+ years in ${pp(a).role} I've used it regularly in production, and I'm comfortable both with the day-to-day work and with troubleshooting the issues that come up. Happy to walk through specific examples.`;
  }
  return GENERIC_FALLBACK(a);
}

module.exports = { generateAnswer };
