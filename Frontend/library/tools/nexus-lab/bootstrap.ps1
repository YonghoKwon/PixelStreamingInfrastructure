param([string]$BaseUri='http://127.0.0.1:48081', [string]$ContainerName='psf-nexus-lab')
$ErrorActionPreference='Stop'
$password=(& docker exec $ContainerName cat /nexus-data/admin.password).Trim()
if($LASTEXITCODE -ne 0 -or -not $password){throw 'Initial lab password unavailable; use an existing authenticated administration session.'}
$headers=@{Authorization='Basic '+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('admin:'+$password))}
$api=$BaseUri.TrimEnd('/')+'/service/rest/v1'
$existing=Invoke-RestMethod -Uri ($api+'/repositories') -Headers $headers
$storage=@{blobStoreName='default';strictContentTypeValidation=$true}
$definitions=@(
 @{type='hosted';body=@{name='psf-releases';online=$true;storage=@{blobStoreName='default';strictContentTypeValidation=$true;writePolicy='allow_once'}}},
 @{type='proxy';body=@{name='npmjs';online=$true;storage=$storage;proxy=@{remoteUrl='https://registry.npmjs.org';contentMaxAge=1440;metadataMaxAge=1440};negativeCache=@{enabled=$true;timeToLive=1440};httpClient=@{blocked=$false;autoBlock=$true}}},
 @{type='group';body=@{name='npm-all';online=$true;storage=$storage;group=@{memberNames=@('psf-releases','npmjs')}}}
)
foreach($definition in $definitions){
 $match=@($existing|Where-Object{$_.name -eq $definition.body.name})
 if($match.Count){if($match[0].format -ne 'npm' -or $match[0].type -ne $definition.type){throw 'Existing lab repository does not match expected format/type'};continue}
 Invoke-RestMethod -Method Post -Uri ($api+'/repositories/npm/'+$definition.type) -Headers $headers -ContentType 'application/json' -Body ($definition.body|ConvertTo-Json -Depth 8)|Out-Null
}
$realms=Invoke-RestMethod -Uri ($api+'/security/realms/active') -Headers $headers
if($realms -notcontains 'NpmToken'){
 $realms=@($realms|ForEach-Object{[string]$_})+@('NpmToken')
 Invoke-RestMethod -Method Put -Uri ($api+'/security/realms/active') -Headers $headers -ContentType 'application/json' -Body (ConvertTo-Json -InputObject $realms)|Out-Null
}
Write-Output 'Lab npm hosted/proxy/group repositories are ready. Existing company npm configuration is unchanged.'
