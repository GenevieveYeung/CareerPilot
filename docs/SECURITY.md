# Security and privacy

Do not commit:

- resumes, cover letters, application records, profile data, visa information, phone numbers or addresses;
- browser sessions, cookies, tokens or screenshots containing personal information;
- QQ SMTP authorization codes or any other secret.

The SMTP authorization code is stored with Windows DPAPI under the current user's local CareerPilot secret directory. The UI receives only configured/not-configured state. Ordinary settings saves must not replace the credential.

Before publishing, scan tracked files for personal data and inspect Git history if this repository has ever been public.
