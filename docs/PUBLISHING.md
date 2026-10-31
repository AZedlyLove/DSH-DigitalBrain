# Publishing this repository

The repo content is ready. Two ways to get it onto GitHub; pick whichever fits your machine.

## Option A — with Git (recommended)

Install Git for Windows if you don't have it:

```powershell
winget install --id Git.Git -e
```

Then, from the repository folder:

```bash
cd E:\BigFish\agent-brain
git init -b main
git add .
git commit -m "feat: initial release of agent-brain 0.1.0"

# create an empty repo on github.com first, then:
git remote add origin https://github.com/AZedlyLove/agent-brain.git
git push -u origin main
```

If `git` asks who you are:

```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

### Personal access token

GitHub no longer accepts account passwords over HTTPS. Create a token at
<https://github.com/settings/tokens> (scope `repo`), and use it as the password when Git prompts.
Or install the GitHub CLI and let it handle auth:

```powershell
winget install --id GitHub.cli -e
gh auth login
gh repo create agent-brain --public --source . --push
```

## Option B — no Git installed (web upload)

1. On GitHub, **New repository** → name `agent-brain` → Public → *do not* add a README
   (this repo already has one).
2. On the new repo page click **uploading an existing file**.
3. Drag the contents of `E:\BigFish\agent-brain` (not the folder itself) into the page,
   including `.github/` if your browser allows hidden folders — otherwise create the workflow
   file later through **Add file → Create new file** with path `.github/workflows/ci.yml`.
4. Commit.

## Before you push — checklist

- [x] Clone URLs point at `github.com/AZedlyLove/agent-brain` (already set in both READMEs).
- [x] `LICENSE` author is `AZedlyLove`.
- [ ] Confirm no state leaked: `git status --ignored` should list only `state/`, `data/`, `*.sqlite*`.
- [ ] Optional: run `node src/cli.mjs status` with a throwaway `DSH_BRAIN_DB` to make sure nothing
      points at a private database path.
- [ ] Add repository topics on GitHub: `llm-agents`, `long-term-memory`, `emotion`, `autonomy`,
      `sqlite`, `nodejs`.
- [ ] If you want a demo GIF, run `node src/demo-autonomy.mjs` and record the terminal.

## Suggested first release

- Tag `v0.1.0` after the first push: **Releases → Draft a new release → tag `v0.1.0`**.
- Release notes can be copied from `CHANGELOG.md`.
- After the first push, enable **Settings → Pages** only if you add a docs site; the README is
  enough for now.
