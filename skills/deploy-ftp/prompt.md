# Deploy FTP

Deploy the project to a remote server via FTP using lftp.

## Configuration

- **host**: {{host}}
- **user**: {{user}}
- **password**: {{password}}
- **remotePath**: {{remotePath}}
- **buildCmd**: {{buildCmd}}
- **outputDir**: {{outputDir}}

## Instructions

You are the CEO agent coordinating a deployment via FTP. Follow these steps in order. If any step fails, stop immediately and report the failure with full error details.

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

### Step 3 - Check for lftp

Verify that `lftp` is installed:

```
which lftp
```

If lftp is not available, try installing it:

- macOS: `brew install lftp`
- Linux: `sudo apt-get install -y lftp` or `sudo yum install -y lftp`

If installation fails, report the error and stop.

### Step 4 - Upload via FTP

Use lftp to mirror the build output to the remote server:

```
lftp -u {{user}},{{password}} {{host}} -e "mirror --reverse --delete --verbose {{outputDir}}/ {{remotePath}}/; quit"
```

- The `--reverse` flag uploads local to remote (reverse mirror).
- The `--delete` flag removes remote files not present locally, keeping the remote in sync.
- The `--verbose` flag provides transfer details.
- If lftp fails (connection refused, auth failure, permission denied, etc.), report the error and stop.
- Note the upload duration and total data transferred if available.

### Step 5 - Verify the deployment

Use lftp to list the remote directory and verify files landed correctly:

```
lftp -u {{user}},{{password}} {{host}} -e "ls {{remotePath}}/; quit"
```

- Compare the remote file listing against the local build output.
- Check that key files exist on the remote (e.g. index.html, main JS/CSS bundles).
- If verification fails, report which files are missing.

### Step 6 - Report

Produce a deployment report with the following sections:

- **Status**: SUCCESS or FAILED
- **Timestamp**: When the deployment ran
- **Build**: Command used, duration, exit code
- **Upload**: Number of files transferred, total size, duration
- **Verification**: Remote file listing, any discrepancies
- **Errors**: Full error output if any step failed

Keep the report factual and concise. No unnecessary commentary.
