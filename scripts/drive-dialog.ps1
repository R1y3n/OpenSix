# Drive a native Windows file dialog without touching the mouse or keyboard: set the text of its file name box and
# press its default button with window messages.
# Usage: powershell -File scripts\drive-dialog.ps1 -Title 'Export FBX' -Path 'C:\folder\model.fbx' [-Timeout 30] [-Cancel]
# The dialog must already be showing. It only touches the file name box (class Edit, id 1001) and the Save, Open or
# Select Folder button (class Button, id 1). With -Cancel it presses Cancel (id 2) instead and types nothing.
# Prints what it did. Exit codes: 1 dialog never appeared, 2 file name box missing, 3 button missing.
param(
  [Parameter(Mandatory)] [string] $Title,
  [string] $Path = '',
  [int] $Timeout = 30,
  [switch] $Cancel
)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Namespace OpenSix -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern System.IntPtr SendMessage(System.IntPtr window, uint message, System.IntPtr wParam, string lParam);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr SendMessage(System.IntPtr window, uint message, System.IntPtr wParam, System.IntPtr lParam);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool PostMessage(System.IntPtr window, uint message, System.IntPtr wParam, System.IntPtr lParam);
'@
$WM_SETTEXT = 0x000C
$WM_CHAR = 0x0102
$BM_CLICK = 0x00F5
$UIA = [System.Windows.Automation.AutomationElement]
$root = $UIA::RootElement
$deadline = (Get-Date).AddSeconds($Timeout)
$named = New-Object System.Windows.Automation.PropertyCondition($UIA::NameProperty, $Title)
$dialog = $null
while ((Get-Date) -lt $deadline -and -not $dialog) {
  $dialog = $root.FindFirst('Children', $named)
  if (-not $dialog) {
    # A modal dialog is usually listed under the window that owns it.
    foreach ($window in $root.FindAll('Children', [System.Windows.Automation.Condition]::TrueCondition)) {
      $dialog = $window.FindFirst('Children', $named)
      if ($dialog) { break }
    }
  }
  if (-not $dialog) { Start-Sleep -Milliseconds 300 }
}
if (-not $dialog) { Write-Output "dialog '$Title' did not appear"; exit 1 }
Write-Output ("dialog found: '{0}' class {1}" -f $dialog.Current.Name, $dialog.Current.ClassName)

function Find-Control($class, $id) {
  foreach ($candidate in $dialog.FindAll('Descendants', [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($candidate.Current.ClassName -eq $class -and $candidate.Current.AutomationId -eq $id -and $candidate.Current.NativeWindowHandle -ne 0) { return $candidate }
  }
  return $null
}
function Handle($control) { return [System.IntPtr]$control.Current.NativeWindowHandle }

if ($Cancel) {
  $cancelButton = Find-Control 'Button' '2'
  if (-not $cancelButton) { Write-Output 'no Cancel button found'; exit 3 }
  [void][OpenSix.Native]::SendMessage((Handle $cancelButton), $BM_CLICK, [System.IntPtr]::Zero, [System.IntPtr]::Zero)
  Write-Output 'pressed Cancel'
  exit 0
}

$edit = Find-Control 'Edit' '1001'
if (-not $edit) { $edit = Find-Control 'Edit' '1152' }   # the folder picker's "Folder:" box
if (-not $edit) { Write-Output 'no file name box found; nothing was typed'; exit 2 }
# Clear the box, then send the characters one by one so the dialog sees the same change notifications as typing.
[void][OpenSix.Native]::SendMessage((Handle $edit), $WM_SETTEXT, [System.IntPtr]::Zero, '')
foreach ($character in $Path.ToCharArray()) {
  [void][OpenSix.Native]::SendMessage((Handle $edit), $WM_CHAR, [System.IntPtr][int]$character, [System.IntPtr]::Zero)
}
Write-Output "typed path: $Path"
$button = Find-Control 'Button' '1'
if (-not $button) { Write-Output 'no default button found'; exit 3 }
Write-Output ("pressing: '{0}'" -f $button.Current.Name)
# PostMessage returns at once, so a dialog that opens a follow-up prompt cannot block this script.
[void][OpenSix.Native]::PostMessage((Handle $button), $BM_CLICK, [System.IntPtr]::Zero, [System.IntPtr]::Zero)
Start-Sleep -Milliseconds 800
# An overwrite prompt may follow. Accept it only if it appears.
$confirm = $root.FindFirst('Children', (New-Object System.Windows.Automation.PropertyCondition($UIA::NameProperty, 'Confirm Save As')))
if ($confirm) {
  foreach ($candidate in $confirm.FindAll('Descendants', [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($candidate.Current.Name -eq 'Yes' -and $candidate.Current.NativeWindowHandle -ne 0) {
      [void][OpenSix.Native]::PostMessage((Handle $candidate), $BM_CLICK, [System.IntPtr]::Zero, [System.IntPtr]::Zero)
      Write-Output 'confirmed overwrite'
      break
    }
  }
}
exit 0
