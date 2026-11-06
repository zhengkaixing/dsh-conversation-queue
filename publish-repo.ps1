# Publish dsh-conversation-queue to GitHub or Gitee.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File publish-repo.ps1 -Provider github -TokenFile C:\path\to\token.txt
#   powershell -ExecutionPolicy Bypass -File publish-repo.ps1 -Provider gitee  -TokenFile C:\path\to\token.txt
#
# The token file must contain only the token (one line, no quotes).
# The script creates the repository, pushes the current branch, and then rewrites
# the origin remote to a clean URL so the token is not left in .git/config.

param(
  [Parameter(Mandatory = $true)][ValidateSet('github', 'gitee')][string]$Provider,
  [Parameter(Mandatory = $true)][string]$TokenFile,
  [string]$RepoName = 'dsh-conversation-queue',
  [string]$Description = 'Cap how many DeepSeek Harness conversations run at once (FIFO queue for the rest), plus a memory/commit/disk status strip in the web UI.',
  [switch]$Private
)

$ErrorActionPreference = 'Stop'
$repoDir = $PSScriptRoot
if (-not (Test-Path (Join-Path $repoDir '.git'))) { throw "not a git repo: $repoDir" }
if (-not (Test-Path $TokenFile)) { throw "token file not found: $TokenFile" }

$token = ([System.IO.File]::ReadAllText($TokenFile, [System.Text.Encoding]::UTF8)).Trim()
if (-not $token) { throw 'token file is empty' }

$ua = @{ 'User-Agent' = 'dsh-publish' }

if ($Provider -eq 'github') {
  $api = 'https://api.github.com'
  $headers = $ua + @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json' }
  $me = Invoke-RestMethod -Method Get -Uri "$api/user" -Headers $headers
  $login = $me.login
  Write-Host "GitHub user: $login"
  $body = @{
    name        = $RepoName
    description = $Description
    private     = [bool]$Private
    has_issues  = $true
    has_wiki    = $false
    auto_init   = $false
  } | ConvertTo-Json -Compress
  try {
    Invoke-RestMethod -Method Post -Uri "$api/user/repos" -Headers $headers -Body $body -ContentType 'application/json' | Out-Null
    Write-Host "created repo $login/$RepoName"
  } catch {
    $status = $_.Exception.Response.StatusCode.value__
    if ($status -eq 422) { Write-Host "repo $login/$RepoName already exists, reusing it" }
    else { throw }
  }
  $webUrl = "https://github.com/$login/$RepoName"
  $pushUrl = "https://x-access-token:$token@github.com/$login/$RepoName.git"
} else {
  $api = 'https://gitee.com/api/v5'
  $me = Invoke-RestMethod -Method Get -Uri "$api/user?access_token=$token" -Headers $ua
  $login = $me.login
  Write-Host "Gitee user: $login"
  $form = @{
    access_token = $token
    name         = $RepoName
    description  = $Description
    private      = if ($Private) { 'true' } else { 'false' }
    auto_init    = 'false'
  }
  try {
    Invoke-RestMethod -Method Post -Uri "$api/user/repos" -Headers $ua -Body $form | Out-Null
    Write-Host "created repo $login/$RepoName"
  } catch {
    $status = $_.Exception.Response.StatusCode.value__
    if ($status -eq 400 -or $status -eq 422) { Write-Host "repo may already exist, reusing it" }
    else { throw }
  }
  $webUrl = "https://gitee.com/$login/$RepoName"
  $pushUrl = "https://$login`:$token@gitee.com/$login/$RepoName.git"
}

Push-Location $repoDir
try {
  $branch = (git rev-parse --abbrev-ref HEAD).Trim()
  $remotes = @(git remote 2>$null)
  if ($remotes -contains 'origin') { git remote set-url origin $pushUrl }
  else { git remote add origin $pushUrl }
  git push -u origin $branch
  if ($LASTEXITCODE -ne 0) { throw "git push failed with exit $LASTEXITCODE" }
} finally {
  # Never leave the token in .git/config.
  git remote set-url origin $webUrl
  Pop-Location
}

Write-Host "pushed to $webUrl"
Write-Host "install command: dsh plugin --profile web add github:$login/$RepoName"
Write-Host "remember to revoke the token when you are done."
