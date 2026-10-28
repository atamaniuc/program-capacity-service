# Tab completion for `make` in this repository: targets, and values for TENANT= and TOPIC=.
#   bash: source tools/completion.bash
#   zsh:  autoload -U +X compinit && compinit && autoload -U +X bashcompinit && bashcompinit \
#         && source tools/completion.bash   (compinit is usually already loaded by your .zshrc)
# Outside a directory whose Makefile has `make targets`, it falls back to file names.

# Candidates from $2 that start with $1 (zsh's compgen emulation does not filter by prefix).
_program_capacity_match() {
  local prefix=$1 word
  COMPREPLY=()
  # Command substitution splits on spaces in both bash and zsh; a bare $2 would not in zsh.
  for word in $(printf '%s' "$2"); do
    [[ $word == "$prefix"* ]] && COMPREPLY+=("$word")
  done
}

_program_capacity_make() {
  local cur=${COMP_WORDS[COMP_CWORD]}
  case $cur in
    TENANT=*)
      _program_capacity_match "$cur" "TENANT=bank-a TENANT=bank-b TENANT=bank-c"
      return
      ;;
    TOPIC=*)
      _program_capacity_match "$cur" "TOPIC=treasury.capacity.v1.dlq TOPIC=treasury.fx-rates.v1.dlq"
      return
      ;;
  esac
  local targets
  targets=$(make -s targets 2>/dev/null | tr '\n' ' ') || targets=""
  if [[ -z $targets ]]; then
    COMPREPLY=($(compgen -f -- "$cur"))
    return
  fi
  _program_capacity_match "$cur" "$targets TENANT= SCOPES= TOPIC= FROM= NO_COLOR=1"
  # Keep the cursor right after "VAR=" so the value can be completed next.
  if [[ ${#COMPREPLY[@]} -eq 1 && ${COMPREPLY[0]} == *= ]]; then
    compopt -o nospace 2>/dev/null
  fi
}

complete -F _program_capacity_make make
