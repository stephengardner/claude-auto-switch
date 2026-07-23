# claude-auto-switch transparent shim.
#
# Makes the `claude` command route through account rotation. Install it into
# your PowerShell profile with `ccx on` (or dot-source this file yourself).
# Remove it with `ccx off`.
#
# The shim calls `ccx run`, which invokes the REAL claude by its absolute path,
# so this function never calls itself.
function claude {
    ccx run -- @args
}
