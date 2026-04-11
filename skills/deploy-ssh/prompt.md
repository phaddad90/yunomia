# Deploy SSH

Deploy the project to a remote server via SSH/SCP.

## Configuration

- **host**: {{host}}
- **user**: {{user}}
- **remotePath**: {{remotePath}}
- **buildCmd**: {{buildCmd}}
- **outputDir**: {{outputDir}}

## Instructions

You are the CEO agent coordinating a deployment via SSH/SCP. Follow these steps in order. If any step fails, stop immediately and report the failure with full error details.

### Step 1 - Build the project

Run the build command:

```
{{buildCmd}}
```

- Capture all stdout and stderr output.
- If the build exits with a non-zero code, report the failure and stop.
- Note the build duration.

### Step 2 - Verify the build output

Check that the output directory `{{outputDir}}` exists and contains files:

- List the contents of the output directory.
- Count the total number of files (recursively).
- If the directory is missing or empty, report the failure and stop.

### Step 3 - Upload via SCP

Upload the build output to the remote server:

```
scp -r {{outputDir}}/* {{user}}@{{host}}:{{remotePath}}/
```

- If SCP fails (connection refused, auth failure, permission denied, etc.), report the error and stop.
- Note the upload duration and total data transferred if available.

### Step 4 - Verify the deployment

SSH into the remote server and verify the files landed correctly:

```
ssh {{user}}@{{host}} "ls -la {{remotePath}}/"
```

- Compare the remote file listing against the local build output.
- Check that key files exist on the remote (e.g. index.html, main JS/CSS bundles).
- If verification fails, report which files are missing.

### Step 5 - Report

Produce a deployment report with the following sections:

- **Status**: SUCCESS or FAILED
- **Timestamp**: When the deployment ran
- **Build**: Command used, duration, exit code
- **Upload**: Number of files transferred, total size, duration
- **Verification**: Remote file listing, any discrepancies
- **Errors**: Full error output if any step failed

Keep the report factual and concise. No unnecessary commentary.
