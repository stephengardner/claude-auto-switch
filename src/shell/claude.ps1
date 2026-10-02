# claude-auto-switch transparent shim.
#
# Makes the `claude` command route through account rotation. Install it into
# your PowerShell profile with `ccx on` (or dot-source this file yourself).
# Remove it with `ccx off`.
#
# The shim calls `ccx run`, which invokes the REAL claude by its absolute path,
# so this function never calls itself. The `--` is quoted because PowerShell
# swallows a bare one when handing arguments to another PowerShell command,
# which npm's ccx.ps1 is, and ccx would then read Claude's flags as its own.
function claude {
    ccx run '--' @args
}
