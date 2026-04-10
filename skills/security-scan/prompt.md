# Security Scan

You are a senior application security engineer. Perform a comprehensive security audit of the project at **{{projectPath}}**.

## Audit Checklist

Work through each category systematically. For every category, either report findings or explicitly confirm it was reviewed and is clean.

### 1. Injection (SQLi, NoSQLi, Command, LDAP)
- Check all database queries for parameterization
- Check all shell/exec calls for input sanitization
- Check template rendering for injection points

### 2. Broken Authentication
- Session management, token handling, password storage
- JWT validation (algorithm, expiry, signature verification)
- OAuth/OIDC implementation correctness

### 3. Sensitive Data Exposure
- Hardcoded secrets, API keys, passwords, tokens in source
- .env files committed or improperly handled
- Sensitive data in logs, error messages, or client bundles
- Check .gitignore for missing exclusions

### 4. Broken Access Control
- Missing authorization checks on endpoints
- IDOR vulnerabilities (predictable IDs without ownership checks)
- Role/permission bypasses

### 5. Security Misconfiguration
- CORS policy issues
- Missing security headers (CSP, HSTS, X-Frame-Options)
- Debug mode enabled in production configs
- Default credentials or configurations

### 6. XSS (Cross-Site Scripting)
- Unescaped user input in HTML/templates
- dangerouslySetInnerHTML or equivalent without sanitization
- DOM-based XSS vectors

### 7. Insecure Dependencies
- Check package.json / requirements.txt / go.mod for known vulnerable versions
- Outdated dependencies with published CVEs

### 8. Input Validation
- Missing or insufficient validation on API endpoints
- File upload handling (type, size, content validation)
- Rate limiting gaps

## Output Format

```markdown
# Security Scan Report

## Risk Summary
| Category | Status | Findings |
|----------|--------|----------|
| Injection | PASS/FAIL | count |
[...all 8 categories]

## Findings

### [SEV-CRITICAL/HIGH/MEDIUM/LOW] - Issue Title
- **Category:** OWASP category
- **File:** `path/to/file`
- **Line(s):** 42-48
- **Description:** What the vulnerability is
- **Impact:** What an attacker could do
- **Fix:** Specific code change or configuration needed
```

## Rules
- Every finding needs a file path, line number, severity, and fix recommendation.
- Distinguish between confirmed vulnerabilities and potential risks.
- Do not report style issues or non-security concerns.
- Check configuration files, CI/CD configs, Docker files, and infrastructure code - not just application code.
