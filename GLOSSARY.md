# prek Autoupdate

The action proposes hook updates for a repository and maintains the pull
requests it creates for those updates.

## Language

**Hook update**: A change produced by `prek autoupdate` to bring the
repository's configured hooks up to date. _Avoid_: prek update

**Base branch**: The branch against which hook updates are prepared and into
which the update pull request would merge.

**Update branch**: The configured source branch for publishing hook updates.

**Action-owned update pull request**: A same-repository pull request carrying
the action's ownership markers and matching its branch and author requirements.
_Avoid_: Bot PR

**Update run**: A run that checks for fresh hook updates and can publish them
through an action-owned update pull request.

**No-update run**: An update run that produces no hook changes to publish.

**Cleanup-only run**: A run limited to reconciling existing action-owned pull
requests and branches.

**Stale update pull request**: An open action-owned update pull request outside
the selection of pull requests the action is keeping during routine cleanup.

**Obsolete update pull request**: An open action-owned update pull request whose
proposed file changes are already reflected in its current base branch, or whose
comparison shows no changed files.
