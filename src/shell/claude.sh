# claude-auto-switch transparent shim (bash/zsh).
#
# Makes the `claude` command route through account rotation. Install it into
# your shell rc file with `ccx on` (or source this file yourself). Remove it
# with `ccx off`.
#
# The shim calls `ccx run`, which invokes the REAL claude by its absolute path,
# so this function never calls itself.
claude() {
    ccx run -- "$@"
}
