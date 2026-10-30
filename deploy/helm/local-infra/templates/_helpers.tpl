{{- define "infra.labels" -}}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: local-infra
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}
