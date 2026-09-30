@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title Claude Code Training Cleanup V26

if /I "%~1"=="--temp-worker" goto :temp_worker

rem 관리자 권한 확인 및 자동 상승 (C-2)
set "CLEANUP_CALLER_PROFILE=%USERPROFILE%"
if /I "%~1"=="--elevated" set "CLEANUP_CALLER_PROFILE=%~2"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()); if($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){exit 0}else{exit 1}" >nul 2>&1
if not errorlevel 1 goto :cleanup_elevated

if /I "%~1"=="--elevated" goto :cleanup_still_not_admin

echo 관리자 권한이 필요합니다. UAC 창에서 [예]를 선택하세요.
set "CLEANUP_SELF_PATH=%~f0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "try { Start-Process -FilePath $env:CLEANUP_SELF_PATH -ArgumentList @('--elevated', $env:CLEANUP_CALLER_PROFILE) -Verb RunAs -ErrorAction Stop } catch { exit 1 }"
if errorlevel 1 goto :cleanup_elevate_failed
exit /b 0

:cleanup_still_not_admin
echo [실행 불가] 관리자 권한이 승인되지 않아 초기화를 실행할 수 없습니다.
echo 현재 Windows 사용자가 관리자 계정인지 확인한 뒤 다시 실행하세요.
pause
exit /b 1

:cleanup_elevate_failed
echo [실행 불가] 관리자 권한 요청이 취소되었거나 승인되지 않았습니다.
echo 초기화 작업은 실행되지 않았습니다.
pause
exit /b 1

:cleanup_elevated
rem 다른 관리자 계정으로 상승하면 USERPROFILE 이 바뀌어 엉뚱한 사용자의 자료를 지우게 된다.
if /I "%CLEANUP_CALLER_PROFILE%"=="%USERPROFILE%" goto :cleanup_profile_ok
echo.
echo [중단] 관리자 계정과 실습 계정이 서로 다릅니다.
echo   실습 계정 프로필 : %CLEANUP_CALLER_PROFILE%
echo   현재 실행 프로필 : %USERPROFILE%
echo.
echo 이대로 진행하면 실습 계정이 아니라 관리자 계정의 자료를 지우게 됩니다.
echo 실습 계정에 관리자 권한을 부여한 뒤 다시 실행하세요.
echo.
pause
exit /b 1

:cleanup_profile_ok
set "CLEANUP_ORIGINAL=%~f0"
set "CLEANUP_TEMP_BAT=%TEMP%\ClaudeTrainingCleanup_%RANDOM%_%RANDOM%.bat"
copy /Y "%CLEANUP_ORIGINAL%" "%CLEANUP_TEMP_BAT%" >nul 2>&1
if errorlevel 1 (
    echo Failed to copy the cleanup file to the temporary folder.
    pause
    exit /b 1
)

start "Claude Training Cleanup" /D "%TEMP%" "%ComSpec%" /D /C call "%CLEANUP_TEMP_BAT%" --temp-worker "%CLEANUP_ORIGINAL%"
exit /b 0

:temp_worker
set "CLEANUP_ORIGINAL=%~2"
set "CLEANUP_SELF=%~f0"
set "CLEANUP_PS=%TEMP%\ClaudeTrainingCleanup_%RANDOM%_%RANDOM%.ps1"
set "CLEANUP_MARKER=%TEMP%\ClaudeTrainingCleanup_%RANDOM%_%RANDOM%.done"

rem Extract the embedded PowerShell section from the temporary BAT copy.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$lines=[IO.File]::ReadAllLines($env:CLEANUP_SELF); $out=New-Object 'System.Collections.Generic.List[string]'; foreach($line in $lines){if($line.StartsWith('::PS::')){[void]$out.Add($line.Substring(6))}}; [IO.File]::WriteAllLines($env:CLEANUP_PS,$out,[Text.UTF8Encoding]::new($true))" >nul 2>&1
if errorlevel 1 (
    echo Failed to prepare the cleanup script.
    pause
    exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%CLEANUP_PS%" -BatchPath "%CLEANUP_ORIGINAL%" -WorkerBatchPath "%CLEANUP_SELF%" -CompletionMarker "%CLEANUP_MARKER%"
set "CLEANUP_EXIT=%ERRORLEVEL%"
del /F /Q "%CLEANUP_PS%" >nul 2>&1
if not exist "%CLEANUP_MARKER%" (
    echo.
    echo An unexpected error stopped the cleanup script. The original BAT was preserved when possible.
    echo Review the PowerShell error shown above.
    pause
)
del /F /Q "%CLEANUP_MARKER%" >nul 2>&1

set "CLEANUP_TEMP_WORKER=%CLEANUP_SELF%"
set "CLEANUP_EXIT_CODE=%CLEANUP_EXIT%"
start "" powershell.exe -NoLogo -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Milliseconds 500; try { Remove-Item -LiteralPath $env:CLEANUP_TEMP_WORKER -Force -ErrorAction Stop } catch { Set-Content -LiteralPath (Join-Path $env:TEMP 'ClaudeTrainingCleanup_DeleteError.log') -Value ('Temporary BAT deletion failed: ' + $env:CLEANUP_TEMP_WORKER + [Environment]::NewLine + $_.Exception.Message) -Encoding UTF8 }; if ($env:CLEANUP_EXIT_CODE -eq '0') { Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\shutdown.exe') -ArgumentList @('/s','/t','0') -WindowStyle Hidden }"
exit /b %CLEANUP_EXIT%

::PS::param(
::PS::    [Parameter(Mandatory = $true)]
::PS::    [string]$BatchPath,
::PS::    [Parameter(Mandatory = $true)]
::PS::    [string]$WorkerBatchPath,
::PS::    [Parameter(Mandatory = $true)]
::PS::    [string]$CompletionMarker
::PS::)
::PS::
::PS::$ErrorActionPreference = 'SilentlyContinue'
::PS::
::PS::# 추출된 임시 PS1은 이미 메모리에 로드되었으므로 즉시 삭제한다.
::PS::# 사용자가 마지막 안내에서 창을 X로 닫아도 TEMP에 사본이 남지 않는다.
::PS::try { Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction Stop } catch {}
::PS::
::PS::$BatchPath = [IO.Path]::GetFullPath($BatchPath)
::PS::$WorkerBatchPath = [IO.Path]::GetFullPath($WorkerBatchPath)
::PS::$issues = New-Object 'System.Collections.Generic.List[string]'
::PS::$permissionSkips = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
::PS::$permissionBlockedPaths = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
::PS::$statusLogPath = Join-Path $env:TEMP 'ClaudeTrainingCleanup_LastStatus.log'
::PS::$statusClock = [Diagnostics.Stopwatch]::StartNew()
::PS::$lastStatusUpdate = [DateTime]::MinValue
::PS::$lastStatusLogUpdate = [DateTime]::MinValue
::PS::$statusLineOpen = $false
::PS::function Get-TextCellWidth {
::PS::    param([string]$Text)
::PS::    $width = 0
::PS::    foreach ($character in $Text.ToCharArray()) {
::PS::        if ([int]$character -gt 255) { $width += 2 } else { $width++ }
::PS::    }
::PS::    return $width
::PS::}
::PS::function Get-LeftTextByCells {
::PS::    param([string]$Text, [int]$MaxCells)
::PS::    $builder = New-Object Text.StringBuilder
::PS::    $used = 0
::PS::    foreach ($character in $Text.ToCharArray()) {
::PS::        $cellWidth = if ([int]$character -gt 255) { 2 } else { 1 }
::PS::        if ($used + $cellWidth -gt $MaxCells) { break }
::PS::        [void]$builder.Append($character)
::PS::        $used += $cellWidth
::PS::    }
::PS::    return $builder.ToString()
::PS::}
::PS::function Get-RightTextByCells {
::PS::    param([string]$Text, [int]$MaxCells)
::PS::    $characters = $Text.ToCharArray()
::PS::    $builder = New-Object Text.StringBuilder
::PS::    $used = 0
::PS::    for ($i = $characters.Length - 1; $i -ge 0; $i--) {
::PS::        $cellWidth = if ([int]$characters[$i] -gt 255) { 2 } else { 1 }
::PS::        if ($used + $cellWidth -gt $MaxCells) { break }
::PS::        [void]$builder.Insert(0, $characters[$i])
::PS::        $used += $cellWidth
::PS::    }
::PS::    return $builder.ToString()
::PS::}
::PS::function Get-CompactStatusText {
::PS::    param([string]$Text, [int]$MaxCells)
::PS::    if ((Get-TextCellWidth $Text) -le $MaxCells) { return $Text }
::PS::    $leftCells = [Math]::Max(1, [Math]::Floor(($MaxCells - 3) * 0.62))
::PS::    $rightCells = [Math]::Max(1, $MaxCells - 3 - $leftCells)
::PS::    return (Get-LeftTextByCells $Text $leftCells) + '...' + (Get-RightTextByCells $Text $rightCells)
::PS::}
::PS::function Set-CurrentStatus {
::PS::    param([string]$Stage, [string]$Detail, [string]$LogDetail, [switch]$RawDisplay, [switch]$Force)
::PS::    $utcNow = [DateTime]::UtcNow
::PS::    if (-not $Force -and ($utcNow - $script:lastStatusUpdate).TotalMilliseconds -lt 200) { return }
::PS::    $elapsed = $script:statusClock.Elapsed
::PS::    $displayFullLine = if ($RawDisplay) { $Detail } else { ('[{0}] 현재: {1} | 경과 {2:00}:{3:00}:{4:00}' -f $Stage, $Detail, [Math]::Floor($elapsed.TotalHours), $elapsed.Minutes, $elapsed.Seconds) }
::PS::    $logText = if ($LogDetail) { $LogDetail } else { $Detail }
::PS::    $logFullLine = ('[{0}] 현재: {1} | 전체 경과 {2:00}:{3:00}:{4:00}' -f $Stage, $logText, [Math]::Floor($elapsed.TotalHours), $elapsed.Minutes, $elapsed.Seconds)
::PS::    try {
::PS::        $consoleWidth = [Math]::Min([Console]::WindowWidth, [Console]::BufferWidth)
::PS::        $safeCells = [Math]::Max(20, $consoleWidth - 3)
::PS::        $line = Get-CompactStatusText $displayFullLine $safeCells
::PS::        $row = [Console]::CursorTop
::PS::        [Console]::SetCursorPosition(0, $row)
::PS::        [Console]::Write(' ' * $safeCells)
::PS::        [Console]::SetCursorPosition(0, $row)
::PS::        [Console]::Write($line)
::PS::        [Console]::SetCursorPosition(0, $row)
::PS::        $script:statusLineOpen = $true
::PS::    } catch {
::PS::        try { $Host.UI.RawUI.WindowTitle = $displayFullLine } catch {}
::PS::        $script:statusLineOpen = $false
::PS::    }
::PS::    $script:lastStatusUpdate = $utcNow
::PS::    if (($Force -and -not $RawDisplay) -or ($utcNow - $script:lastStatusLogUpdate).TotalSeconds -ge 1) {
::PS::        try { Set-Content -LiteralPath $script:statusLogPath -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $logFullLine.Trim()) -Encoding UTF8 -Force -ErrorAction SilentlyContinue } catch {}
::PS::        $script:lastStatusLogUpdate = $utcNow
::PS::    }
::PS::}
::PS::function Complete-CurrentStatus {
::PS::    param([string]$Stage, [string]$Detail)
::PS::    Set-CurrentStatus $Stage $Detail -Force
::PS::    if ($script:statusLineOpen) {
::PS::        try {
::PS::            $consoleWidth = [Math]::Min([Console]::WindowWidth, [Console]::BufferWidth)
::PS::            $safeCells = [Math]::Max(20, $consoleWidth - 3)
::PS::            $row = [Console]::CursorTop
::PS::            [Console]::SetCursorPosition(0, $row)
::PS::            [Console]::Write(' ' * $safeCells)
::PS::            [Console]::SetCursorPosition(0, $row)
::PS::        } catch {}
::PS::    }
::PS::    $script:statusLineOpen = $false
::PS::}
::PS::function Set-CompletionMarker {
::PS::    try { Set-Content -LiteralPath $CompletionMarker -Value 'completed' -Encoding ASCII -Force -ErrorAction Stop } catch {}
::PS::}
::PS::
::PS::function Test-IsPermissionFailure {
::PS::    param([System.Exception]$Exception)
::PS::    $currentException = $Exception
::PS::    while ($currentException) {
::PS::        if ($currentException -is [System.UnauthorizedAccessException]) { return $true }
::PS::        if ($currentException -is [System.ComponentModel.Win32Exception] -and $currentException.NativeErrorCode -eq 5) { return $true }
::PS::        if ($currentException.HResult -eq -2147024891) { return $true }
::PS::        if ($currentException.Message -match 'access.*denied|access to.*denied|액세스.*거부|접근.*거부|권한.*없') { return $true }
::PS::        $currentException = $currentException.InnerException
::PS::    }
::PS::    return $false
::PS::}
::PS::
::PS::function Test-IsSharingViolation {
::PS::    param([System.Exception]$Exception)
::PS::    $currentException = $Exception
::PS::    while ($currentException) {
::PS::        if ($currentException -is [System.ComponentModel.Win32Exception] -and ($currentException.NativeErrorCode -eq 32 -or $currentException.NativeErrorCode -eq 33)) { return $true }
::PS::        $win32Code = $currentException.HResult -band 0xFFFF
::PS::        if ($win32Code -eq 32 -or $win32Code -eq 33) { return $true }
::PS::        if ($currentException.Message -match 'being used by another process|used by another process|process cannot access|다른 프로세스.*사용|프로세스가.*사용 중|사용 중이므로') { return $true }
::PS::        $currentException = $currentException.InnerException
::PS::    }
::PS::    return $false
::PS::}
::PS::
::PS::# ---- 긴 경로(MAX_PATH 260자 초과) 대응 ----
::PS::# Windows PowerShell 5.1 + LongPathsEnabled=0 환경에서는 260자를 넘는 경로에
::PS::# Get-ChildItem / Remove-Item 이 DirectoryNotFoundException 으로 실패한다.
::PS::# (node_modules 같은 깊은 트리에서 실제로 발생하며, 권한/잠금 오류가 아니라서
::PS::#  기존 분류 로직에도 걸리지 않고 그대로 실패로 남는다.)
::PS::# \\?\ 확장 경로 접두사를 붙이면 짧은 경로에서도 안전하게 동작한다.
::PS::function Get-LongPath {
::PS::    param([string]$Path)
::PS::    if ([string]::IsNullOrWhiteSpace($Path)) { return $Path }
::PS::    if ($Path.StartsWith('\\?\')) { return $Path }
::PS::    if ($Path.StartsWith('\\')) { return ('\\?\UNC\' + $Path.Substring(2)) }
::PS::    if ($Path.Length -ge 2 -and $Path[1] -eq ':') { return ('\\?\' + $Path) }
::PS::    return $Path
::PS::}
::PS::function Get-NormalPath {
::PS::    param([string]$Path)
::PS::    if ([string]::IsNullOrWhiteSpace($Path)) { return $Path }
::PS::    if ($Path.StartsWith('\\?\UNC\')) { return ('\\' + $Path.Substring(8)) }
::PS::    if ($Path.StartsWith('\\?\')) { return $Path.Substring(4) }
::PS::    return $Path
::PS::}
::PS::function Test-IsLongPathFailure {
::PS::    param([System.Exception]$Exception)
::PS::    $currentException = $Exception
::PS::    while ($currentException) {
::PS::        if ($currentException -is [System.IO.PathTooLongException]) { return $true }
::PS::        if ($currentException -is [System.IO.DirectoryNotFoundException]) { return $true }
::PS::        if ($currentException -is [System.IO.FileNotFoundException]) { return $true }
::PS::        $currentException = $currentException.InnerException
::PS::    }
::PS::    return $false
::PS::}
::PS::function Get-ChildItemSafe {
::PS::    param([string]$Path, [switch]$Recurse, [switch]$Directory)
::PS::    $arguments = @{ Force = $true; ErrorAction = 'Stop' }
::PS::    if ($Recurse) { $arguments['Recurse'] = $true }
::PS::    if ($Directory) { $arguments['Directory'] = $true }
::PS::    try {
::PS::        return @(Get-ChildItem -LiteralPath $Path @arguments)
::PS::    } catch {
::PS::        if (-not (Test-IsLongPathFailure $_.Exception)) { throw }
::PS::        $extendedPath = Get-LongPath $Path
::PS::        if ($extendedPath -eq $Path) { throw }
::PS::        return @(Get-ChildItem -LiteralPath $extendedPath @arguments)
::PS::    }
::PS::}
::PS::function Remove-ItemSafe {
::PS::    param([string]$Path, [switch]$Recurse)
::PS::    if (-not $Recurse) {
::PS::        [NativePathDeletion]::Delete((Get-NormalPath $Path))
::PS::        return
::PS::    }
::PS::    $arguments = @{ Force = $true; ErrorAction = 'Stop' }
::PS::    $arguments['Recurse'] = $true
::PS::    $normalPath = Get-NormalPath $Path
::PS::    try {
::PS::        Remove-Item -LiteralPath $normalPath @arguments
::PS::    } catch {
::PS::        if (-not (Test-IsLongPathFailure $_.Exception)) { throw }
::PS::        Remove-Item -LiteralPath (Get-LongPath $normalPath) @arguments
::PS::    }
::PS::    if ([NativePathDeletion]::Exists($normalPath)) {
::PS::        throw [System.IO.IOException]::new(('재귀 삭제 후에도 경로가 남아 있습니다: ' + $normalPath))
::PS::    }
::PS::}
::PS::
::PS::$lockInspectorAvailable = $false
::PS::$lockInspectorInitError = ''
::PS::try {
::PS::    Add-Type -TypeDefinition @'
::PS::using System;
::PS::using System.ComponentModel;
::PS::using System.Collections.Generic;
::PS::using System.IO;
::PS::using System.Runtime.InteropServices;
::PS::using System.Text;
::PS::
::PS::public sealed class FileLockOwner
::PS::{
::PS::    public int ProcessId { get; set; }
::PS::    public string ApplicationName { get; set; }
::PS::    public string ServiceShortName { get; set; }
::PS::    public uint ApplicationType { get; set; }
::PS::}
::PS::
::PS::public static class NativePathDeletion
::PS::{
::PS::    private const uint INVALID_FILE_ATTRIBUTES = 0xFFFFFFFF;
::PS::    private const uint FILE_ATTRIBUTE_READONLY = 0x00000001;
::PS::    private const uint FILE_ATTRIBUTE_HIDDEN = 0x00000002;
::PS::    private const uint FILE_ATTRIBUTE_SYSTEM = 0x00000004;
::PS::    private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
::PS::    private const int ERROR_FILE_NOT_FOUND = 2;
::PS::    private const int ERROR_PATH_NOT_FOUND = 3;
::PS::
::PS::    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
::PS::    private static extern uint GetFileAttributesW(string fileName);
::PS::
::PS::    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
::PS::    [return: MarshalAs(UnmanagedType.Bool)]
::PS::    private static extern bool SetFileAttributesW(string fileName, uint fileAttributes);
::PS::
::PS::    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
::PS::    [return: MarshalAs(UnmanagedType.Bool)]
::PS::    private static extern bool DeleteFileW(string fileName);
::PS::
::PS::    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
::PS::    [return: MarshalAs(UnmanagedType.Bool)]
::PS::    private static extern bool RemoveDirectoryW(string pathName);
::PS::
::PS::    private static string ToExtendedPath(string path)
::PS::    {
::PS::        if (String.IsNullOrWhiteSpace(path)) { throw new ArgumentException("Path is empty.", "path"); }
::PS::        if (path.StartsWith(@"\\?\")) { return path; }
::PS::        if (path.StartsWith(@"\\")) { return @"\\?\UNC\" + path.Substring(2); }
::PS::        return @"\\?\" + System.IO.Path.GetFullPath(path);
::PS::    }
::PS::
::PS::    public static bool Exists(string path)
::PS::    {
::PS::        uint attributes = GetFileAttributesW(ToExtendedPath(path));
::PS::        if (attributes != INVALID_FILE_ATTRIBUTES) { return true; }
::PS::        int lookupError = Marshal.GetLastWin32Error();
::PS::        if (lookupError == ERROR_FILE_NOT_FOUND || lookupError == ERROR_PATH_NOT_FOUND) { return false; }
::PS::        throw new Win32Exception(lookupError);
::PS::    }
::PS::
::PS::    public static void Delete(string path)
::PS::    {
::PS::        string extendedPath = ToExtendedPath(path);
::PS::        uint attributes = GetFileAttributesW(extendedPath);
::PS::        if (attributes == INVALID_FILE_ATTRIBUTES)
::PS::        {
::PS::            int lookupError = Marshal.GetLastWin32Error();
::PS::            if (lookupError == ERROR_FILE_NOT_FOUND || lookupError == ERROR_PATH_NOT_FOUND) { return; }
::PS::            throw new Win32Exception(lookupError);
::PS::        }
::PS::
::PS::        uint removableAttributes = attributes & ~(FILE_ATTRIBUTE_READONLY | FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM);
::PS::        if (removableAttributes != attributes && !SetFileAttributesW(extendedPath, removableAttributes))
::PS::        {
::PS::            throw new Win32Exception(Marshal.GetLastWin32Error());
::PS::        }
::PS::
::PS::        bool isDirectory = (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
::PS::        bool deleted = isDirectory ? RemoveDirectoryW(extendedPath) : DeleteFileW(extendedPath);
::PS::        if (!deleted)
::PS::        {
::PS::            int deleteError = Marshal.GetLastWin32Error();
::PS::            if (deleteError == ERROR_FILE_NOT_FOUND || deleteError == ERROR_PATH_NOT_FOUND) { return; }
::PS::            throw new Win32Exception(deleteError);
::PS::        }
::PS::        uint remainingAttributes = GetFileAttributesW(extendedPath);
::PS::        if (remainingAttributes != INVALID_FILE_ATTRIBUTES)
::PS::        {
::PS::            throw new IOException("삭제 명령 후에도 경로가 남아 있습니다: " + path);
::PS::        }
::PS::        int verificationError = Marshal.GetLastWin32Error();
::PS::        if (verificationError != ERROR_FILE_NOT_FOUND && verificationError != ERROR_PATH_NOT_FOUND)
::PS::        {
::PS::            throw new Win32Exception(verificationError);
::PS::        }
::PS::    }
::PS::}
::PS::
::PS::public static class RestartManagerLockInspector
::PS::{
::PS::    private const int CCH_RM_SESSION_KEY = 32;
::PS::    private const int CCH_RM_MAX_APP_NAME = 255;
::PS::    private const int CCH_RM_MAX_SVC_NAME = 63;
::PS::    private const int ERROR_SUCCESS = 0;
::PS::    private const int ERROR_MORE_DATA = 234;
::PS::
::PS::    [StructLayout(LayoutKind.Sequential)]
::PS::    private struct RM_UNIQUE_PROCESS
::PS::    {
::PS::        public int dwProcessId;
::PS::        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
::PS::    }
::PS::
::PS::    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
::PS::    private struct RM_PROCESS_INFO
::PS::    {
::PS::        public RM_UNIQUE_PROCESS Process;
::PS::        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_APP_NAME + 1)]
::PS::        public string strAppName;
::PS::        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_SVC_NAME + 1)]
::PS::        public string strServiceShortName;
::PS::        public uint ApplicationType;
::PS::        public uint AppStatus;
::PS::        public uint TSSessionId;
::PS::        [MarshalAs(UnmanagedType.Bool)]
::PS::        public bool bRestartable;
::PS::    }
::PS::
::PS::    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
::PS::    private static extern int RmStartSession(out uint sessionHandle, int sessionFlags, StringBuilder sessionKey);
::PS::
::PS::    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
::PS::    private static extern int RmRegisterResources(uint sessionHandle, uint fileCount, string[] fileNames, uint applicationCount, IntPtr applications, uint serviceCount, string[] serviceNames);
::PS::
::PS::    [DllImport("rstrtmgr.dll")]
::PS::    private static extern int RmGetList(uint sessionHandle, out uint processInfoNeeded, ref uint processInfo, [In, Out] RM_PROCESS_INFO[] affectedApplications, ref uint rebootReasons);
::PS::
::PS::    [DllImport("rstrtmgr.dll")]
::PS::    private static extern int RmEndSession(uint sessionHandle);
::PS::
::PS::    public static FileLockOwner[] GetOwners(string fullFilePath)
::PS::    {
::PS::        uint sessionHandle;
::PS::        StringBuilder sessionKey = new StringBuilder(CCH_RM_SESSION_KEY + 1);
::PS::        int result = RmStartSession(out sessionHandle, 0, sessionKey);
::PS::        if (result != ERROR_SUCCESS) { throw new InvalidOperationException("RmStartSession failed: " + result); }
::PS::        try
::PS::        {
::PS::            result = RmRegisterResources(sessionHandle, 1, new string[] { fullFilePath }, 0, IntPtr.Zero, 0, null);
::PS::            if (result != ERROR_SUCCESS) { throw new InvalidOperationException("RmRegisterResources failed: " + result); }
::PS::
::PS::            uint needed = 0;
::PS::            uint count = 0;
::PS::            uint rebootReasons = 0;
::PS::            result = RmGetList(sessionHandle, out needed, ref count, null, ref rebootReasons);
::PS::            if (result == ERROR_SUCCESS && needed == 0) { return new FileLockOwner[0]; }
::PS::            if (result != ERROR_MORE_DATA) { throw new InvalidOperationException("RmGetList(size) failed: " + result); }
::PS::
::PS::            RM_PROCESS_INFO[] processInfo = new RM_PROCESS_INFO[needed];
::PS::            count = needed;
::PS::            result = RmGetList(sessionHandle, out needed, ref count, processInfo, ref rebootReasons);
::PS::            if (result != ERROR_SUCCESS) { throw new InvalidOperationException("RmGetList(data) failed: " + result); }
::PS::
::PS::            List<FileLockOwner> owners = new List<FileLockOwner>();
::PS::            for (int index = 0; index < count; index++)
::PS::            {
::PS::                owners.Add(new FileLockOwner {
::PS::                    ProcessId = processInfo[index].Process.dwProcessId,
::PS::                    ApplicationName = processInfo[index].strAppName,
::PS::                    ServiceShortName = processInfo[index].strServiceShortName,
::PS::                    ApplicationType = processInfo[index].ApplicationType
::PS::                });
::PS::            }
::PS::            return owners.ToArray();
::PS::        }
::PS::        finally
::PS::        {
::PS::            RmEndSession(sessionHandle);
::PS::        }
::PS::    }
::PS::}
::PS::'@ -Language CSharp -ErrorAction Stop
::PS::    $lockInspectorAvailable = $true
::PS::} catch {
::PS::    $lockInspectorInitError = $_.Exception.Message
::PS::}
::PS::
::PS::$autoStopLockProcessNames = @(
::PS::    'node', 'claude', 'notepad', 'notepad++', 'alzip', 'bandizip',
::PS::    '7zfm', '7zg', 'winrar', 'winzip', 'code', 'code - insiders', 'vscodium',
::PS::    'powershell', 'pwsh', 'cmd', 'chrome', 'msedge'
::PS::)
::PS::$protectedLockProcessNames = @(
::PS::    'system', 'registry', 'idle', 'smss', 'csrss', 'wininit', 'services',
::PS::    'lsass', 'winlogon', 'dwm', 'fontdrvhost', 'sihost', 'explorer',
::PS::    'msmpeng', 'nissrv', 'searchindexer', 'trustedinstaller'
::PS::)
::PS::$lockEvents = New-Object 'System.Collections.Generic.List[string]'
::PS::
::PS::function Get-LockOwnerDisplayName {
::PS::    param($Owner, $Process)
::PS::    if ($Process) { return ($Process.ProcessName + '.exe') }
::PS::    if ($Owner.ApplicationName) { return $Owner.ApplicationName }
::PS::    if ($Owner.ServiceShortName) { return ('서비스 ' + $Owner.ServiceShortName) }
::PS::    return '알 수 없는 프로세스'
::PS::}
::PS::
::PS::function Remove-PathWithLockRecovery {
::PS::    param([System.IO.FileSystemInfo]$Target)
::PS::    $lastException = $null
::PS::    for ($attempt = 0; $attempt -le 3; $attempt++) {
::PS::        try {
::PS::            # 파일은 DeleteFileW, 폴더는 RemoveDirectoryW로 한 항목씩만 삭제한다.
::PS::            # 폴더가 비어있지 않으면 오류로 남기므로 상위 폴더가 내부 파일 삭제를 우회하지 않는다.
::PS::            Remove-ItemSafe $Target.FullName
::PS::            return [pscustomobject]@{ Status = 'Deleted'; Exception = $null }
::PS::        } catch {
::PS::            $lastException = $_.Exception
::PS::            if (Test-IsPermissionFailure $lastException) {
::PS::                return [pscustomobject]@{ Status = 'Permission'; Exception = $lastException }
::PS::            }
::PS::            if ($Target.PSIsContainer -or -not (Test-IsSharingViolation $lastException)) {
::PS::                return [pscustomobject]@{ Status = 'Failed'; Exception = $lastException }
::PS::            }
::PS::            if (-not $lockInspectorAvailable) {
::PS::                $message = '파일 잠금 조회 기능을 준비하지 못했습니다: ' + $lockInspectorInitError
::PS::                [void]$script:lockEvents.Add($message)
::PS::                return [pscustomobject]@{ Status = 'Failed'; Exception = $lastException }
::PS::            }
::PS::
::PS::            Set-CurrentStatus '6/6' ('잠금 소유 프로그램 조회 중: ' + $Target.FullName) -Force
::PS::            try { $owners = @([RestartManagerLockInspector]::GetOwners($Target.FullName)) }
::PS::            catch {
::PS::                [void]$script:lockEvents.Add(('잠금 조회 실패: ' + $Target.FullName + ' - ' + $_.Exception.Message))
::PS::                return [pscustomobject]@{ Status = 'Failed'; Exception = $lastException }
::PS::            }
::PS::            if ($owners.Count -eq 0) {
::PS::                [void]$script:lockEvents.Add(('잠금 소유 프로그램을 찾지 못함: ' + $Target.FullName))
::PS::                return [pscustomobject]@{ Status = 'Failed'; Exception = $lastException }
::PS::            }
::PS::            if ($attempt -ge 3) {
::PS::                [void]$script:lockEvents.Add(('잠금 해제 후 3회 재시도했으나 삭제 실패: ' + $Target.FullName))
::PS::                return [pscustomobject]@{ Status = 'Failed'; Exception = $lastException }
::PS::            }
::PS::
::PS::            $stoppedAny = $false
::PS::            foreach ($owner in $owners) {
::PS::                $ownerPid = [int]$owner.ProcessId
::PS::                $ownerProcess = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
::PS::                $displayName = Get-LockOwnerDisplayName $owner $ownerProcess
::PS::                $processKey = if ($ownerProcess) { $ownerProcess.ProcessName.ToLowerInvariant() } else { '' }
::PS::                Complete-CurrentStatus '6/6' '파일 잠금 소유 프로그램 확인'
::PS::                Write-Host ''
::PS::                Write-Host ('[잠금 감지] ' + $Target.FullName) -ForegroundColor Yellow
::PS::                Write-Host ('[사용 프로그램] ' + $displayName + ' (PID ' + $ownerPid + ')') -ForegroundColor Yellow
::PS::
::PS::                if (-not $ownerProcess -and [string]::IsNullOrWhiteSpace($owner.ServiceShortName)) {
::PS::                    Write-Host '[안내] 조회 직후 프로세스가 이미 종료되어 삭제를 바로 재시도합니다.' -ForegroundColor Cyan
::PS::                    [void]$script:lockEvents.Add(('잠금 프로세스가 조회 후 종료됨: ' + $Target.FullName + ' -> ' + $displayName + ' (PID ' + $ownerPid + ')'))
::PS::                    $stoppedAny = $true
::PS::                    continue
::PS::                }
::PS::
::PS::                $isCurrentCleanup = ($ownerPid -eq $PID -or $ownerPid -eq $script:workerCmdPid)
::PS::                $isWindowsService = -not [string]::IsNullOrWhiteSpace($owner.ServiceShortName) -or $owner.ApplicationType -eq 3 -or $owner.ApplicationType -eq 1000
::PS::                $isProtectedShell = $owner.ApplicationType -eq 4
::PS::                $isProtected = $isCurrentCleanup -or $ownerPid -le 4 -or $isWindowsService -or $isProtectedShell -or ($protectedLockProcessNames -icontains $processKey)
::PS::                if ($isProtected) {
::PS::                    $reason = if ($isCurrentCleanup) { '현재 초기화 작업 자체' } else { '보호된 Windows 프로세스 또는 서비스' }
::PS::                    Write-Host ('[보호] ' + $reason + '이므로 강제 종료하지 않습니다.') -ForegroundColor Red
::PS::                    [void]$script:lockEvents.Add(('보호 프로세스로 인한 삭제 실패: ' + $Target.FullName + ' -> ' + $displayName + ' (PID ' + $ownerPid + ')'))
::PS::                    continue
::PS::                }
::PS::
::PS::                $shouldStop = $autoStopLockProcessNames -icontains $processKey
::PS::                if ($shouldStop) {
::PS::                    Write-Host '[자동 처리] 실습 관련 프로그램을 강제 종료합니다.' -ForegroundColor Cyan
::PS::                } else {
::PS::                    Write-Host '[확인 필요] 자동 종료 대상이 아닌 프로그램입니다.' -ForegroundColor Yellow
::PS::                    $shouldStop = Wait-ForEnterOrEscape '강제 종료하고 삭제를 재시도하려면 Enter, 이 파일을 건너뛰려면 Esc: '
::PS::                }
::PS::                if (-not $shouldStop) {
::PS::                    [void]$script:lockEvents.Add(('사용자가 잠금 프로세스 종료를 취소함: ' + $Target.FullName + ' -> ' + $displayName + ' (PID ' + $ownerPid + ')'))
::PS::                    continue
::PS::                }
::PS::                try {
::PS::                    Stop-Process -Id $ownerPid -Force -ErrorAction Stop
::PS::                    $stoppedAny = $true
::PS::                    Write-Host ('[종료 완료] ' + $displayName + ' (PID ' + $ownerPid + ')') -ForegroundColor Green
::PS::                    [void]$script:lockEvents.Add(('잠금 프로세스 종료: ' + $Target.FullName + ' -> ' + $displayName + ' (PID ' + $ownerPid + ')'))
::PS::                } catch {
::PS::                    if (Test-IsPermissionFailure $_.Exception) {
::PS::                        Register-PermissionSkip ('잠금 프로세스 종료: ' + $displayName + ' (PID ' + $ownerPid + ')')
::PS::                    } else {
::PS::                        [void]$script:lockEvents.Add(('잠금 프로세스 종료 실패: ' + $Target.FullName + ' -> ' + $displayName + ' (PID ' + $ownerPid + ') - ' + $_.Exception.Message))
::PS::                    }
::PS::                }
::PS::            }
::PS::            if (-not $stoppedAny) {
::PS::                return [pscustomobject]@{ Status = 'Failed'; Exception = $lastException }
::PS::            }
::PS::            Write-Host ('[재시도] 잠금 해제를 기다린 뒤 삭제합니다. (' + ($attempt + 1) + '/3)') -ForegroundColor Cyan
::PS::            Start-Sleep -Milliseconds 500
::PS::        }
::PS::    }
::PS::    return [pscustomobject]@{ Status = 'Failed'; Exception = $lastException }
::PS::}
::PS::
::PS::function Register-PermissionSkip {
::PS::    param([string]$Description)
::PS::    [void]$permissionSkips.Add($Description)
::PS::}
::PS::
::PS::function Wait-ForEnterOrEscape {
::PS::    param([string]$Message)
::PS::    Write-Host $Message -NoNewline
::PS::    while ($true) {
::PS::        $key = [Console]::ReadKey($true)
::PS::        if ($key.Key -eq [ConsoleKey]::Enter) {
::PS::            Write-Host ''
::PS::            return $true
::PS::        }
::PS::        if ($key.Key -eq [ConsoleKey]::Escape) {
::PS::            Write-Host ''
::PS::            return $false
::PS::        }
::PS::    }
::PS::}
::PS::
::PS::function Remove-OriginalBatch {
::PS::    if (-not (Test-Path -LiteralPath $BatchPath)) { return $true }
::PS::    try {
::PS::        Remove-ItemSafe $BatchPath
::PS::        Write-Host ('[완료] 원본 초기화 BAT 삭제: ' + $BatchPath)
::PS::        return $true
::PS::    } catch {
::PS::        if (Test-IsPermissionFailure $_.Exception) {
::PS::            Register-PermissionSkip ('원본 BAT 삭제: ' + $BatchPath)
::PS::            Write-Host ('[건너뜀] 권한 부족으로 원본 BAT를 유지합니다: ' + $BatchPath) -ForegroundColor Yellow
::PS::            return $true
::PS::        }
::PS::        Write-Host ('[경고] 원본 초기화 BAT를 삭제하지 못했습니다: ' + $BatchPath) -ForegroundColor Yellow
::PS::        return $false
::PS::    }
::PS::}
::PS::
::PS::function Restore-OriginalBatch {
::PS::    if (Test-Path -LiteralPath $BatchPath) { return $true }
::PS::    try {
::PS::        $parent = [IO.Path]::GetDirectoryName($BatchPath)
::PS::        if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
::PS::            [void](New-Item -ItemType Directory -Path $parent -Force -ErrorAction Stop)
::PS::        }
::PS::        Copy-Item -LiteralPath $WorkerBatchPath -Destination $BatchPath -Force -ErrorAction Stop
::PS::        return $true
::PS::    } catch {
::PS::        [void]$issues.Add(('원본 BAT 복원 실패: ' + $BatchPath + ' - ' + $_.Exception.Message))
::PS::        return $false
::PS::    }
::PS::}
::PS::
::PS::function Test-IsKnownTrainingName {
::PS::    param([string]$Name)
::PS::    if (-not $Name) { return $false }
::PS::    $normalized = ($Name.ToLowerInvariant() -replace '[\s_\-\.\(\)\[\]]', '')
::PS::    # 세 조건을 각각 독립으로 본다. 이름 안에 '삼성', 'ds', '실습' 이 순서와 위치에
::PS::    # 관계없이 모두 들어 있으면 실습자료로 인식한다.
::PS::    # 기존 '삼성(?:전자)?ds.*실습' 은 (1) 삼성 바로 뒤에 ds 가 붙어야 하고
::PS::    # (2) 그 뒤에 실습이 와야 해서 'DS실습_삼성', '삼성전자 반도체 DS 실습' 등이 누락됐다.
::PS::    # 세 조건을 모두 요구하므로 'A Track - AI Agent 빌더 과정' 같은 교안,
::PS::    # 'A Track - 삼성전자 DS 과정'(실습 없음), '2일차 실습자료'(삼성/ds 없음) 는 계속 제외된다.
::PS::    if ($normalized -match '삼성' -and $normalized -match 'ds' -and $normalized -match '실습') { return $true }
::PS::    if ($normalized -match 'samsung' -and $normalized -match 'ds' -and $normalized -match 'practice') { return $true }
::PS::    return $false
::PS::}
::PS::
::PS::function Test-IsOrdinaryDataFile {
::PS::    param([System.IO.FileInfo]$File)
::PS::    if (Test-IsKnownTrainingName $File.Name) { return $true }
::PS::    $safeExtensions = @(
::PS::        '.zip', '.7z', '.rar', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv',
::PS::        '.ppt', '.pptx', '.txt', '.md', '.png',
::PS::        '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.mp4', '.mov', '.avi',
::PS::        '.mkv', '.wav', '.mp3'
::PS::    )
::PS::    return $safeExtensions -icontains $File.Extension
::PS::}
::PS::
::PS::# ---- 백신 디코이(미끼) 파일 제외 ----
::PS::# 안랩 V3 등 보안 제품은 랜섬웨어를 탐지하려고 문서 폴더에 미끼 파일을 심는다.
::PS::# 이 파일들은 생성 시각이 계속 갱신되어 "오늘 9시 이후" 조건에 항상 걸리고,
::PS::# 삭제를 시도하면 백신이 이 스크립트를 랜섬웨어로 오탐해 도중에 차단한다.
::PS::# 아래 조건을 '모두' 만족할 때만 미끼로 보고 건너뛴다. 하나라도 어긋나면
::PS::# 정상 자료로 간주해 삭제 대상에 그대로 남긴다. (오제외 방지)
::PS::$decoySkips = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
::PS::$decoyExtensions = @('.doc','.docx','.hwp','.hwpx','.xls','.xlsx','.ppt','.pptx',
::PS::                     '.jpg','.jpeg','.bmp','.png','.gif','.pdf','.txt','.zip','.rtf','.csv')
::PS::function Test-DecoyFolderShape {
::PS::    param([string]$Path)
::PS::    $name = Split-Path -Leaf $Path
::PS::    try { $children = @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction Stop) } catch { return $false }
::PS::    if ($children.Count -lt 4) { return $false }
::PS::    if (@($children | Where-Object { $_.PSIsContainer }).Count -gt 0) { return $false }
::PS::    $matching = @($children | Where-Object {
::PS::        [IO.Path]::GetFileNameWithoutExtension($_.Name) -ieq $name -and $decoyExtensions -icontains $_.Extension })
::PS::    if ($matching.Count -ne $children.Count) { return $false }
::PS::    if (@($matching | Select-Object -ExpandProperty Extension -Unique).Count -lt 4) { return $false }
::PS::    $lengths = @($matching | Select-Object -ExpandProperty Length -Unique)
::PS::    if ($lengths.Count -ne 1) { return $false }
::PS::    if ($lengths[0] -le 0) { return $false }
::PS::    # 결정타: 서로 호환되지 않는 확장자인데 내용까지 완전히 같으면 실제 자료일 수 없다.
::PS::    try {
::PS::        $hashes = @($matching | ForEach-Object { (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256 -ErrorAction Stop).Hash } | Select-Object -Unique)
::PS::    } catch { return $false }
::PS::    if ($hashes.Count -ne 1) { return $false }
::PS::    return $true
::PS::}
::PS::function Test-IsSecurityDecoy {
::PS::    param([System.IO.FileSystemInfo]$Item)
::PS::    if ($Item.PSIsContainer) { return (Test-DecoyFolderShape $Item.FullName) }
::PS::    if (-not ($decoyExtensions -icontains $Item.Extension)) { return $false }
::PS::    # 미끼 폴더 바로 옆에 같은 이름으로 떨어져 있는 낱개 미끼 파일만 함께 제외한다.
::PS::    $twin = Join-Path $Item.DirectoryName ([IO.Path]::GetFileNameWithoutExtension($Item.Name))
::PS::    if (-not (Test-Path -LiteralPath $twin -PathType Container)) { return $false }
::PS::    return (Test-DecoyFolderShape $twin)
::PS::}
::PS::
::PS::Clear-Host
::PS::Write-Host '================================================================'
::PS::Write-Host '  교육 종료 - Claude Code 및 금일 실습자료 초기화'
::PS::Write-Host '================================================================'
::PS::Write-Host ''
::PS::Write-Host '실행 내용:'
::PS::Write-Host '  1. Claude Code, Chrome, Edge, 모든 Node.js, 다른 PowerShell 및 CMD 세션 종료'
::PS::Write-Host '     현재 Windows 사용자의 Chrome/Edge 정식/Beta/Dev/Canary 로컬 프로필 전체 삭제'
::PS::Write-Host '     Pixel Agents 레이아웃, 에이전트 및 좌석 상태 초기화'
::PS::Write-Host '  2. Auto Memory 비활성화'
::PS::Write-Host '  3. ~/.claude 안의 Claude 기록 전체 삭제 (아래 유지 항목만 제외)'
::PS::Write-Host '     대화기록, 세션, 셸 스냅샷, 백업, CLAUDE.md, rules, agents, commands, skills 등'
::PS::Write-Host '  4. .claude.json의 모든 프로젝트 항목과 TEMP의 Claude 작업 폴더 삭제'
::PS::Write-Host '  5. 오늘 오전 9시 이후 생성 항목과 삼성 DS 실습명 항목 검색, 파일 잠금 해제 및 삭제'
::PS::Write-Host '  6. 모든 작업 완료 후 원본 초기화 BAT 삭제'
::PS::Write-Host ''
::PS::Write-Host '검색 범위: 기존 사용자 폴더와 C:\ 바로 아래 항목'
::PS::Write-Host '유지 항목: Claude 로그인, User MCP, .claude.json의 비프로젝트 설정, settings.json, 플러그인'
::PS::Write-Host ''
::PS::Write-Host '주의: Chrome과 Edge에 저장된 모든 계정, 쿠키, 캐시, 방문 기록, 비밀번호,' -ForegroundColor Red
::PS::Write-Host '      북마크와 확장 프로그램이 이 Windows 사용자에서 삭제됩니다.' -ForegroundColor Red
::PS::Write-Host '      이 PC의 브라우저 로그인만 제거되며 계정 탈퇴나 서버 데이터 삭제는 하지 않습니다.' -ForegroundColor Yellow
::PS::Write-Host '주의: 검색 범위 안에서 오늘 오전 9시 이후 생성된 개인 파일도 대상이 됩니다.' -ForegroundColor Yellow
::PS::Write-Host '      삼성 DS 실습자료 이름과 일치하면 생성 날짜와 관계없이 대상이 됩니다.' -ForegroundColor Yellow
::PS::Write-Host '      위치상 애매한 폴더는 검색 중 Enter 또는 Esc로 개별 확인합니다.' -ForegroundColor Yellow
::PS::Write-Host '      삭제 대상은 실제 삭제 전에 다시 표시됩니다.' -ForegroundColor Yellow
::PS::Write-Host ('진행 상태 기록: ' + $statusLogPath) -ForegroundColor Cyan
::PS::Write-Host ''
::PS::Write-Host '[실행 대기] 5초 후 교육 종료 초기화를 자동으로 시작합니다.' -ForegroundColor Red
::PS::Write-Host '실수로 실행했다면 카운트다운 중 Esc를 눌러 취소하세요.' -ForegroundColor Yellow
::PS::$startupCancelled = $false
::PS::for ($remaining = 5; $remaining -ge 1; $remaining--) {
::PS::    Write-Host ('  초기화 시작까지 {0}초...' -f $remaining) -ForegroundColor Cyan
::PS::    for ($tick = 0; $tick -lt 10; $tick++) {
::PS::        Start-Sleep -Milliseconds 100
::PS::        try {
::PS::            if ([Console]::KeyAvailable) {
::PS::                $startupKey = [Console]::ReadKey($true)
::PS::                if ($startupKey.Key -eq [ConsoleKey]::Escape) {
::PS::                    $startupCancelled = $true
::PS::                    break
::PS::                }
::PS::            }
::PS::        } catch {}
::PS::    }
::PS::    if ($startupCancelled) { break }
::PS::}
::PS::if ($startupCancelled) {
::PS::    Write-Host '[취소] 초기화를 시작하지 않았습니다.' -ForegroundColor Green
::PS::    Set-CompletionMarker
::PS::    exit 2
::PS::}
::PS::Write-Host '[시작] 교육 종료 초기화를 시작합니다.' -ForegroundColor Green
::PS::Write-Host ''
::PS::Write-Host '[1/6] Claude Code, Chrome, Edge, 모든 Node.js, 다른 PowerShell 및 CMD 세션을 종료하고 브라우저를 초기화합니다...'
::PS::Set-CurrentStatus '1/6' '현재 초기화 CMD 식별 중' -Force
::PS::$workerCmdPid = 0
::PS::$canStopOtherCmd = $true
::PS::try {
::PS::    $selfProcess = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $PID) -ErrorAction Stop
::PS::    $workerCmdPid = [int]$selfProcess.ParentProcessId
::PS::} catch {
::PS::    $canStopOtherCmd = $false
::PS::    if (Test-IsPermissionFailure $_.Exception) {
::PS::        Register-PermissionSkip '현재 임시 CMD 식별 및 다른 CMD 종료'
::PS::    } else {
::PS::        [void]$issues.Add(('현재 임시 CMD 식별 실패: ' + $_.Exception.Message))
::PS::    }
::PS::}
::PS::try {
::PS::    Set-CurrentStatus '1/6' 'Windows 프로세스 목록 조회 중' -Force
::PS::    $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
::PS::        $_.ProcessId -ne $PID -and $_.ProcessId -ne $workerCmdPid -and (
::PS::            $_.Name -ieq 'claude.exe' -or
::PS::            $_.Name -ieq 'powershell.exe' -or
::PS::            $_.Name -ieq 'pwsh.exe' -or
::PS::            $_.Name -ieq 'node.exe' -or
::PS::            $_.Name -ieq 'chrome.exe' -or
::PS::            $_.Name -ieq 'chrome_proxy.exe' -or
::PS::            $_.Name -ieq 'GoogleCrashHandler.exe' -or
::PS::            $_.Name -ieq 'GoogleCrashHandler64.exe' -or
::PS::            $_.Name -ieq 'msedge.exe' -or
::PS::            ($_.Name -ieq 'cmd.exe' -and $canStopOtherCmd)
::PS::        )
::PS::    })
::PS::} catch {
::PS::    $processes = @()
::PS::    if (Test-IsPermissionFailure $_.Exception) {
::PS::        Register-PermissionSkip '종료 대상 프로세스 조회'
::PS::    } else {
::PS::        [void]$issues.Add(('종료 대상 프로세스 조회 실패: ' + $_.Exception.Message))
::PS::    }
::PS::}
::PS::$processIndex = 0
::PS::foreach ($process in $processes) {
::PS::    $processIndex++
::PS::    Set-CurrentStatus '1/6' ('프로세스 종료 중 {0}/{1}: {2} (PID {3})' -f $processIndex, $processes.Count, $process.Name, $process.ProcessId) -Force
::PS::    try {
::PS::        Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
::PS::    } catch {
::PS::        if (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue) {
::PS::            if (Test-IsPermissionFailure $_.Exception) {
::PS::                Register-PermissionSkip ('프로세스 종료: ' + $process.Name + ' (PID ' + $process.ProcessId + ')')
::PS::            } else {
::PS::                [void]$issues.Add(('프로세스 종료 실패: ' + $process.Name + ' (PID ' + $process.ProcessId + ')'))
::PS::            }
::PS::        }
::PS::    }
::PS::}
::PS::Complete-CurrentStatus '1/6' ('종료 대상 프로세스 처리 완료: ' + $processes.Count + '개')
::PS::Start-Sleep -Milliseconds 1000
::PS::
::PS::$pixelAgentsRoot = Join-Path $env:USERPROFILE '.pixel-agents'
::PS::$pixelAgentsStateFiles = @('layout.json', 'standalone-state.json', 'vscode-state.json')
::PS::$pixelAgentsStateFound = $false
::PS::foreach ($pixelAgentsStateName in $pixelAgentsStateFiles) {
::PS::    $pixelAgentsStatePath = Join-Path $pixelAgentsRoot $pixelAgentsStateName
::PS::    if (-not (Test-Path -LiteralPath $pixelAgentsStatePath -PathType Leaf)) { continue }
::PS::    $pixelAgentsStateFound = $true
::PS::    try {
::PS::        Set-CurrentStatus '1/6' ('Pixel Agents 상태 삭제 중: ' + $pixelAgentsStateName) -Force
::PS::        Remove-ItemSafe $pixelAgentsStatePath
::PS::        Write-Host ('[완료] Pixel Agents 상태 삭제: ' + $pixelAgentsStatePath)
::PS::    } catch {
::PS::        Complete-CurrentStatus '1/6' ('Pixel Agents 상태 삭제 중 문제 발생: ' + $pixelAgentsStateName)
::PS::        if (Test-IsPermissionFailure $_.Exception) {
::PS::            Register-PermissionSkip ('Pixel Agents 상태 삭제: ' + $pixelAgentsStatePath)
::PS::            Write-Host ('[건너뜀] 권한 부족으로 Pixel Agents 상태를 유지합니다: ' + $pixelAgentsStatePath) -ForegroundColor Yellow
::PS::        } else {
::PS::            [void]$issues.Add(('Pixel Agents 상태 삭제 실패: ' + $pixelAgentsStatePath + ' - ' + $_.Exception.Message))
::PS::            Write-Host ('[경고] Pixel Agents 상태를 삭제하지 못했습니다: ' + $pixelAgentsStatePath) -ForegroundColor Yellow
::PS::        }
::PS::    }
::PS::}
::PS::if (-not $pixelAgentsStateFound) {
::PS::    Write-Host '[정상] 삭제할 Pixel Agents 레이아웃, 에이전트 또는 좌석 상태가 없습니다.'
::PS::}
::PS::Complete-CurrentStatus '1/6' 'Pixel Agents 상태 초기화 완료'
::PS::
::PS::$browserProfileGroups = @(
::PS::    [PSCustomObject]@{
::PS::        Name = 'Chrome'
::PS::        Paths = @(
::PS::            (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'),
::PS::            (Join-Path $env:LOCALAPPDATA 'Google\Chrome Beta\User Data'),
::PS::            (Join-Path $env:LOCALAPPDATA 'Google\Chrome Dev\User Data'),
::PS::            (Join-Path $env:LOCALAPPDATA 'Google\Chrome SxS\User Data')
::PS::        )
::PS::    },
::PS::    [PSCustomObject]@{
::PS::        Name = 'Edge'
::PS::        Paths = @(
::PS::            (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data'),
::PS::            (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge Beta\User Data'),
::PS::            (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge Dev\User Data'),
::PS::            (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge SxS\User Data')
::PS::        )
::PS::    }
::PS::)
::PS::foreach ($browserProfileGroup in $browserProfileGroups) {
::PS::    $browserProfileFound = $false
::PS::    foreach ($browserProfilePath in $browserProfileGroup.Paths) {
::PS::        if (-not (Test-Path -LiteralPath $browserProfilePath -PathType Container)) { continue }
::PS::        $browserProfileFound = $true
::PS::        try {
::PS::            Set-CurrentStatus '1/6' ($browserProfileGroup.Name + ' 프로필 삭제 중: ' + $browserProfilePath) -Force
::PS::            Remove-ItemSafe $browserProfilePath -Recurse
::PS::            Complete-CurrentStatus '1/6' ($browserProfileGroup.Name + ' 프로필 삭제 완료')
::PS::            Write-Host ('[완료] ' + $browserProfileGroup.Name + ' 로컬 프로필 전체 삭제: ' + $browserProfilePath)
::PS::        } catch {
::PS::            Complete-CurrentStatus '1/6' ($browserProfileGroup.Name + ' 프로필 삭제 중 문제 발생')
::PS::            if (Test-IsPermissionFailure $_.Exception) {
::PS::                Register-PermissionSkip ($browserProfileGroup.Name + ' 로컬 프로필 삭제: ' + $browserProfilePath)
::PS::                Write-Host ('[건너뜀] 권한 부족으로 ' + $browserProfileGroup.Name + ' 로컬 프로필을 삭제하지 못했습니다: ' + $browserProfilePath) -ForegroundColor Yellow
::PS::            } else {
::PS::                [void]$issues.Add(($browserProfileGroup.Name + ' 로컬 프로필 삭제 실패: ' + $browserProfilePath + ' - ' + $_.Exception.Message))
::PS::                Write-Host ('[경고] ' + $browserProfileGroup.Name + ' 로컬 프로필을 삭제하지 못했습니다: ' + $browserProfilePath) -ForegroundColor Yellow
::PS::            }
::PS::        }
::PS::    }
::PS::    if (-not $browserProfileFound) {
::PS::        Write-Host ('[정상] 삭제할 ' + $browserProfileGroup.Name + ' 로컬 프로필이 없습니다.')
::PS::    }
::PS::}
::PS::Complete-CurrentStatus '1/6' '프로세스 종료와 브라우저 초기화 단계 완료'
::PS::
::PS::Write-Host '[2/6] Auto Memory를 현재 Windows 사용자에서 비활성화합니다...'
::PS::Set-CurrentStatus '2/6' '사용자 환경변수 설정 중' -Force
::PS::try {
::PS::    [Environment]::SetEnvironmentVariable('CLAUDE_CODE_DISABLE_AUTO_MEMORY', '1', 'User')
::PS::    $env:CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1'
::PS::} catch {
::PS::    Complete-CurrentStatus '2/6' 'Auto Memory 환경변수 설정 중 문제 발생'
::PS::    if (Test-IsPermissionFailure $_.Exception) {
::PS::        Register-PermissionSkip 'Auto Memory 사용자 환경변수 설정'
::PS::        Write-Host '[건너뜀] 권한 부족으로 Auto Memory 사용자 환경변수를 변경하지 못했습니다.' -ForegroundColor Yellow
::PS::    } else {
::PS::        [void]$issues.Add(('Auto Memory 비활성화 실패: ' + $_.Exception.Message))
::PS::        Write-Host '[경고] Auto Memory 비활성화 설정에 실패했습니다.' -ForegroundColor Yellow
::PS::    }
::PS::}
::PS::Complete-CurrentStatus '2/6' 'Auto Memory 비활성화 단계 완료'
::PS::Start-Sleep -Milliseconds 1000
::PS::
::PS::Write-Host '[3/6] Claude Code 설치와 버전을 확인합니다...'
::PS::Set-CurrentStatus '3/6' 'claude 명령 경로 확인 중' -Force
::PS::$claudeCommand = Get-Command claude -ErrorAction SilentlyContinue
::PS::if (-not $claudeCommand) {
::PS::    Complete-CurrentStatus '3/6' 'claude 명령을 찾지 못함'
::PS::    [void]$issues.Add('claude 명령을 찾을 수 없습니다. Claude Code 설치 또는 PATH를 확인해야 합니다.')
::PS::    Write-Host '[경고] claude 명령을 찾을 수 없어 Claude 자체 purge는 건너뜁니다.' -ForegroundColor Yellow
::PS::} else {
::PS::    Set-CurrentStatus '3/6' 'Claude Code 버전 확인 명령 실행 중' -Force
::PS::    $versionText = (& claude --version 2>&1 | Out-String).Trim()
::PS::    Complete-CurrentStatus '3/6' 'Claude Code 버전 확인 명령 종료'
::PS::    if ($LASTEXITCODE -ne 0) {
::PS::        if ($versionText -match 'EACCES|EPERM|permission.*denied|access.*denied|액세스.*거부|권한') {
::PS::            Register-PermissionSkip 'Claude Code 버전 확인'
::PS::        } else {
::PS::            [void]$issues.Add(('Claude Code 버전 확인 실패: ' + $versionText))
::PS::        }
::PS::    } else {
::PS::        Write-Host ('감지된 Claude Code 버전: ' + $versionText)
::PS::    }
::PS::}
::PS::Complete-CurrentStatus '3/6' 'Claude Code 설치와 버전 확인 단계 완료'
::PS::Start-Sleep -Milliseconds 1000
::PS::
::PS::Write-Host '[4/6] 로그인과 User MCP는 유지하고 Claude Code 프로젝트 정보 전체를 삭제합니다...'
::PS::Set-CurrentStatus '4/6' 'Claude 프로젝트 전체 정리 준비 중' -Force
::PS::$configRoot = Join-Path $env:USERPROFILE '.claude'
::PS::function Get-ClaudeProjectStateStatus {
::PS::    $status = [PSCustomObject]@{ Known = $true; HasState = $false; Detail = '' }
::PS::    $projectRoot = Join-Path $configRoot 'projects'
::PS::    try {
::PS::        if (Test-Path -LiteralPath $projectRoot -PathType Container -ErrorAction Stop) {
::PS::            $firstProjectEntry = Get-ChildItem -LiteralPath $projectRoot -Force -ErrorAction Stop | Select-Object -First 1
::PS::            if ($null -ne $firstProjectEntry) { $status.HasState = $true }
::PS::        }
::PS::    } catch {
::PS::        $status.Known = $false
::PS::        $status.Detail = 'projects 폴더 확인 실패: ' + $_.Exception.Message
::PS::    }
::PS::    $globalConfigPath = Join-Path $env:USERPROFILE '.claude.json'
::PS::    try {
::PS::        if (Test-Path -LiteralPath $globalConfigPath -PathType Leaf -ErrorAction Stop) {
::PS::            $globalConfigText = Get-Content -LiteralPath $globalConfigPath -Raw -ErrorAction Stop
::PS::            if (-not [string]::IsNullOrWhiteSpace($globalConfigText)) {
::PS::                $globalConfig = $globalConfigText | ConvertFrom-Json -ErrorAction Stop
::PS::                $projectsProperty = $globalConfig.PSObject.Properties['projects']
::PS::                if ($null -ne $projectsProperty -and $null -ne $projectsProperty.Value) {
::PS::                    if (@($projectsProperty.Value.PSObject.Properties).Count -gt 0) { $status.HasState = $true }
::PS::                }
::PS::            }
::PS::        }
::PS::    } catch {
::PS::        $status.Known = $false
::PS::        if ($status.Detail) { $status.Detail += ' / ' }
::PS::        $status.Detail += '.claude.json 확인 실패: ' + $_.Exception.Message
::PS::    }
::PS::    return $status
::PS::}
::PS::# 공식 명령으로 ~/.claude.json의 projects 항목까지 정리한다.
::PS::# 로그인과 최상위 User 범위 MCP는 유지되지만 프로젝트별 Local MCP는 함께 삭제된다.
::PS::if ($claudeCommand) {
::PS::    $projectStateBeforePurge = Get-ClaudeProjectStateStatus
::PS::    Set-CurrentStatus '4/6' 'claude project purge --all 실행 중' -Force
::PS::    $purgeText = (& claude project purge --all --yes 2>&1 | Out-String).TrimEnd()
::PS::    $purgeExit = $LASTEXITCODE
::PS::    $projectStateAfterPurge = Get-ClaudeProjectStateStatus
::PS::    Complete-CurrentStatus '4/6' 'claude project purge --all 명령 종료'
::PS::    if ($purgeText) { Write-Host $purgeText }
::PS::    if ($purgeExit -eq 0) {
::PS::        Write-Host '[완료] Claude 프로젝트 설정과 기록을 공식 명령으로 정리했습니다.'
::PS::    } elseif ($purgeText -match '(?i)No Claude Code project state found|프로젝트.*(상태|기록).*(없|찾지 못)') {
::PS::        Write-Host '[정상] Claude가 삭제할 프로젝트 상태를 찾지 못했습니다.'
::PS::    } elseif ($purgeExit -eq 1 -and [string]::IsNullOrWhiteSpace($purgeText) -and $projectStateAfterPurge.Known -and -not $projectStateAfterPurge.HasState) {
::PS::        if ($projectStateBeforePurge.Known -and $projectStateBeforePurge.HasState) {
::PS::            Write-Host '[완료] Claude 명령은 출력 없이 종료 코드 1을 반환했지만 남은 프로젝트 상태가 없어 정리 완료로 처리합니다.'
::PS::        } else {
::PS::            Write-Host '[정상] 삭제할 Claude 프로젝트 상태가 없어 명령이 출력 없이 종료 코드 1을 반환했습니다.'
::PS::        }
::PS::    } elseif ($purgeText -match 'EACCES|EPERM|permission.*denied|access.*denied|액세스.*거부|권한') {
::PS::        Register-PermissionSkip 'Claude project purge --all 명령'
::PS::        Write-Host '[건너뜀] 권한 문제로 프로젝트 설정 정리를 완료하지 못했습니다.' -ForegroundColor Yellow
::PS::    } else {
::PS::        $purgeFailureDetail = if ($purgeText) { $purgeText } else { '명령 출력 없음' }
::PS::        [void]$issues.Add(('Claude project purge --all 실패 (종료 코드 ' + $purgeExit + '): ' + $purgeFailureDetail))
::PS::        Write-Host '[경고] 공식 프로젝트 정리 명령이 실패했습니다. 파일 기록 직접 삭제는 계속합니다.' -ForegroundColor Yellow
::PS::    }
::PS::} else {
::PS::    Write-Host '[경고] claude 명령이 없어 .claude.json의 프로젝트 항목은 정리할 수 없습니다.' -ForegroundColor Yellow
::PS::}
::PS::# 공식 명령의 성공 여부와 관계없이 디스크의 대화와 메모리 파일을 직접 정리한다.
::PS::foreach ($name in @('projects', 'tasks', 'debug', 'file-history', 'paste-cache', 'uploads', 'plans', 'session-env', 'history.jsonl')) {
::PS::    $path = Join-Path $configRoot $name
::PS::    if (Test-Path -LiteralPath $path) {
::PS::        try {
::PS::            Set-CurrentStatus '4/6' ('로컬 Claude 기록 삭제 중: ' + $path) -Force
::PS::            Remove-ItemSafe $path -Recurse
::PS::            Complete-CurrentStatus '4/6' ('로컬 Claude 기록 삭제 완료: ' + $name)
::PS::            Write-Host ('[완료] 로컬 기록 삭제: ' + $path)
::PS::        } catch {
::PS::            Complete-CurrentStatus '4/6' ('로컬 Claude 기록 삭제 중 문제 발생: ' + $name)
::PS::            if (Test-IsPermissionFailure $_.Exception) {
::PS::                Register-PermissionSkip ('로컬 Claude 기록 삭제: ' + $path)
::PS::                Write-Host ('[건너뜀] 권한 부족으로 로컬 기록을 유지합니다: ' + $path) -ForegroundColor Yellow
::PS::            } else {
::PS::                Write-Host ('[경고] 로컬 기록을 삭제하지 못했습니다: ' + $path) -ForegroundColor Yellow
::PS::                [void]$issues.Add(('로컬 Claude 기록 삭제 실패: ' + $path + ' - ' + $_.Exception.Message))
::PS::            }
::PS::        }
::PS::    }
::PS::}
::PS::
::PS::# ---- 사각지대 없는 정리 ----
::PS::# 지울 이름을 나열하는 방식은 Claude Code 버전이 올라가며 새 폴더가 생길 때마다
::PS::# 누락된다. 실제로 claude project purge 는 shell-snapshots / backups / sessions /
::PS::# downloads 를 건드리지 않는다고 스스로 명시한다.
::PS::# 그래서 반대로 "남길 것"만 지정하고 ~/.claude 안의 나머지는 전부 삭제한다.
::PS::#   .credentials.json : 로그인 토큰 (지우면 재로그인 필요)
::PS::#   settings.json     : 교육용 기본 설정
::PS::#   plugins           : 교육 환경 구성용 플러그인
::PS::# 이 세 가지도 초기화하려면 아래 $claudeKeepNames 에서 빼면 된다.
::PS::$claudeKeepNames = @('.credentials.json', 'settings.json', 'plugins')
::PS::$claudeEntries = @()
::PS::try {
::PS::    Set-CurrentStatus '4/6' ('남은 Claude 기록 조회 중: ' + $configRoot) -Force
::PS::    if (Test-Path -LiteralPath $configRoot -PathType Container) { $claudeEntries = @(Get-ChildItemSafe $configRoot) }
::PS::} catch {
::PS::    if (Test-IsPermissionFailure $_.Exception) {
::PS::        Register-PermissionSkip ('남은 Claude 기록 조회: ' + $configRoot)
::PS::    } else {
::PS::        [void]$issues.Add(('남은 Claude 기록 조회 실패: ' + $configRoot + ' - ' + $_.Exception.Message))
::PS::    }
::PS::}
::PS::foreach ($claudeEntry in $claudeEntries) {
::PS::    if ($claudeKeepNames -icontains $claudeEntry.Name) { continue }
::PS::    try {
::PS::        Set-CurrentStatus '4/6' ('Claude 기록 삭제 중: ' + $claudeEntry.Name) -Force
::PS::        Remove-ItemSafe $claudeEntry.FullName -Recurse
::PS::        Write-Host ('[완료] Claude 기록 삭제: ' + $claudeEntry.Name)
::PS::    } catch {
::PS::        if (Test-IsPermissionFailure $_.Exception) {
::PS::            Register-PermissionSkip ('Claude 기록 삭제: ' + $claudeEntry.FullName)
::PS::            Write-Host ('[건너뜀] 권한 부족으로 유지합니다: ' + $claudeEntry.Name) -ForegroundColor Yellow
::PS::        } else {
::PS::            Write-Host ('[경고] 삭제하지 못했습니다: ' + $claudeEntry.Name) -ForegroundColor Yellow
::PS::            [void]$issues.Add(('Claude 기록 삭제 실패: ' + $claudeEntry.FullName + ' - ' + $_.Exception.Message))
::PS::        }
::PS::    }
::PS::}
::PS::Complete-CurrentStatus '4/6' 'Claude 기록 정리 단계 완료'
::PS::Start-Sleep -Milliseconds 1000
::PS::
::PS::Write-Host '[5/6] .claude.json은 유지하고 임시 폴더의 Claude 흔적을 정리합니다...'
::PS::# 사용자 범위 CLAUDE.md / rules / agents / commands / skills 등은 모두 ~/.claude 안에 있고
::PS::# 4단계의 유지목록 방식 삭제로 이미 제거된다. 여기서는 그 바깥에 남는 것만 처리한다.
::PS::Set-CurrentStatus '5/6' '.claude.json 보존 확인 중' -Force
::PS::Write-Host '[유지] .claude.json은 로그인과 개인 MCP 설정 보호를 위해 직접 편집하지 않습니다.'
::PS::
::PS::# Claude Code 가 작업 폴더마다 만드는 임시 스크래치패드.
::PS::# 폴더 이름 자체에 실습 폴더 경로가 인코딩되어 남는다.
::PS::$tempClaudeRoot = Join-Path $env:TEMP 'claude'
::PS::if (Test-Path -LiteralPath $tempClaudeRoot) {
::PS::    try {
::PS::        Set-CurrentStatus '5/6' ('임시 Claude 작업 폴더 삭제 중: ' + $tempClaudeRoot) -Force
::PS::        Remove-ItemSafe $tempClaudeRoot -Recurse
::PS::        Write-Host ('[완료] 임시 Claude 작업 폴더 삭제: ' + $tempClaudeRoot)
::PS::    } catch {
::PS::        if (Test-IsPermissionFailure $_.Exception) {
::PS::            Register-PermissionSkip ('임시 Claude 작업 폴더 삭제: ' + $tempClaudeRoot)
::PS::        } else {
::PS::            [void]$issues.Add(('임시 Claude 작업 폴더 삭제 실패: ' + $tempClaudeRoot + ' - ' + $_.Exception.Message))
::PS::        }
::PS::    }
::PS::}
::PS::
::PS::# 이전 실행이 TEMP에 남긴 정리 스크립트 사본. 마지막 안내에서 창을 X로 닫으면
::PS::# cmd 쪽 뒷정리가 실행되지 않아 BAT/PS1 전체 사본이 그대로 쌓인다.
::PS::# 진행 상태 로그(*_LastStatus.log)는 확인용으로 남긴다.
::PS::try {
::PS::    $staleResidue = @(Get-ChildItemSafe $env:TEMP | Where-Object {
::PS::        -not $_.PSIsContainer -and
::PS::        $_.Name -like 'ClaudeTrainingCleanup_*' -and
::PS::        (@('.bat', '.ps1') -icontains $_.Extension) -and
::PS::        ((Get-NormalPath $_.FullName) -ine $WorkerBatchPath)
::PS::    })
::PS::    foreach ($staleFile in $staleResidue) {
::PS::        try {
::PS::            Remove-ItemSafe $staleFile.FullName
::PS::            Write-Host ('[완료] 이전 실행 잔여 사본 삭제: ' + $staleFile.Name)
::PS::        } catch {
::PS::            if (Test-IsPermissionFailure $_.Exception) {
::PS::                Register-PermissionSkip ('이전 실행 잔여 사본 삭제: ' + $staleFile.FullName)
::PS::            } else {
::PS::                [void]$issues.Add(('이전 실행 잔여 사본 삭제 실패: ' + $staleFile.FullName))
::PS::            }
::PS::        }
::PS::    }
::PS::} catch {
::PS::    [void]$issues.Add(('TEMP 잔여 사본 조회 실패: ' + $_.Exception.Message))
::PS::}
::PS::Complete-CurrentStatus '5/6' '사용자 범위 설정과 임시 폴더 정리 단계 완료'
::PS::Start-Sleep -Milliseconds 1000
::PS::
::PS::Write-Host '[6/6] 오늘 오전 9시 이후 생성 항목과 삼성 DS 실습명 항목을 검색합니다...'
::PS::Set-CurrentStatus '6/6' '검색 위치 구성 중' -Force
::PS::$now = Get-Date
::PS::$cutoff = $now.Date.AddHours(9)
::PS::$possibleRoots = New-Object 'System.Collections.Generic.List[string]'
::PS::[void]$possibleRoots.Add([Environment]::GetFolderPath('Desktop'))
::PS::[void]$possibleRoots.Add([Environment]::GetFolderPath('MyDocuments'))
::PS::[void]$possibleRoots.Add((Join-Path $env:USERPROFILE 'Downloads'))
::PS::try {
::PS::    $shell = New-Object -ComObject Shell.Application
::PS::    $downloadPath = $shell.NameSpace('shell:Downloads').Self.Path
::PS::    if ($downloadPath) { [void]$possibleRoots.Add($downloadPath) }
::PS::} catch {}
::PS::if ($env:OneDrive) {
::PS::    foreach ($relative in @('Desktop', '바탕 화면', 'Documents', '문서', 'Downloads', '다운로드')) {
::PS::        [void]$possibleRoots.Add((Join-Path $env:OneDrive $relative))
::PS::    }
::PS::}
::PS::function Test-IsSameOrChildPath {
::PS::    param([string]$Path, [string]$Parent)
::PS::    $childPath = [IO.Path]::GetFullPath((Get-NormalPath $Path)).TrimEnd('\')
::PS::    $parentPath = [IO.Path]::GetFullPath((Get-NormalPath $Parent)).TrimEnd('\')
::PS::    return ($childPath -ieq $parentPath) -or (($childPath + '\').StartsWith($parentPath + '\', [StringComparison]::OrdinalIgnoreCase))
::PS::}
::PS::
::PS::$canonicalCandidates = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
::PS::foreach ($root in $possibleRoots) {
::PS::    if ($root -and (Test-Path -LiteralPath $root -PathType Container)) {
::PS::        try { [void]$canonicalCandidates.Add([IO.Path]::GetFullPath($root).TrimEnd('\')) } catch {}
::PS::    }
::PS::}
::PS::$roots = New-Object 'System.Collections.Generic.List[string]'
::PS::foreach ($candidate in @($canonicalCandidates | Sort-Object Length, @{Expression={$_}})) {
::PS::    $covered = $false
::PS::    foreach ($existing in $roots) {
::PS::        if (Test-IsSameOrChildPath $candidate $existing) { $covered = $true; break }
::PS::    }
::PS::    if (-not $covered) { [void]$roots.Add($candidate) }
::PS::}
::PS::$coreRootPaths = @($roots)
::PS::$batchDirectory = [IO.Path]::GetDirectoryName($BatchPath).TrimEnd('\')
::PS::$systemDriveBase = ([IO.Path]::GetPathRoot($env:SystemDrive + '\')).TrimEnd('\')
::PS::$protectedBatchPrefixes = @(
::PS::    $env:SystemRoot, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramData,
::PS::    (Join-Path $systemDriveBase 'Recovery'), (Join-Path $systemDriveBase '$Recycle.Bin'),
::PS::    (Join-Path $systemDriveBase 'System Volume Information'), $env:TEMP, $env:TMP,
::PS::    $env:LOCALAPPDATA, $env:APPDATA
::PS::) | Where-Object { $_ }
::PS::$protectedBatchExact = @($systemDriveBase, $env:USERPROFILE) | Where-Object { $_ }
::PS::$batchDirectoryProtected = $false
::PS::foreach ($path in $protectedBatchExact) {
::PS::    if ($batchDirectory -ieq ([IO.Path]::GetFullPath($path).TrimEnd('\'))) { $batchDirectoryProtected = $true }
::PS::}
::PS::foreach ($path in $protectedBatchPrefixes) {
::PS::    $prefix = [IO.Path]::GetFullPath($path).TrimEnd('\') + '\'
::PS::    if (($batchDirectory + '\').StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { $batchDirectoryProtected = $true }
::PS::}
::PS::$usersRoot = (Join-Path $systemDriveBase 'Users').TrimEnd('\') + '\'
::PS::$userProfilePrefix = [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\') + '\'
::PS::if (($batchDirectory + '\').StartsWith($usersRoot, [StringComparison]::OrdinalIgnoreCase) -and -not ($batchDirectory + '\').StartsWith($userProfilePrefix, [StringComparison]::OrdinalIgnoreCase)) {
::PS::    $batchDirectoryProtected = $true
::PS::}
::PS::$batchAlreadyCovered = $false
::PS::foreach ($root in $roots) {
::PS::    if (Test-IsSameOrChildPath $batchDirectory $root) { $batchAlreadyCovered = $true; break }
::PS::}
::PS::if (-not $batchDirectoryProtected -and -not $batchAlreadyCovered -and (Test-Path -LiteralPath $batchDirectory -PathType Container)) {
::PS::    [void]$roots.Add($batchDirectory)
::PS::}
::PS::
::PS::$targets = New-Object 'System.Collections.Generic.List[System.IO.FileSystemInfo]'
::PS::$targetPaths = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
::PS::$excludedAmbiguous = New-Object 'System.Collections.Generic.List[string]'
::PS::$deferredBatchFolder = $null
::PS::function Add-CleanupTarget {
::PS::    param([System.IO.FileSystemInfo]$Item)
::PS::    $path = [IO.Path]::GetFullPath((Get-NormalPath $Item.FullName)).TrimEnd('\')
::PS::    if ($path -ieq $BatchPath) { return }
::PS::    if ($targetPaths.Add($path)) { [void]$targets.Add($Item) }
::PS::}
::PS::
::PS::function Test-ContainsOriginalBatch {
::PS::    param([string]$FolderPath)
::PS::    return Test-IsSameOrChildPath $BatchPath $FolderPath
::PS::}
::PS::
::PS::function Request-AmbiguousFolder {
::PS::    param([System.IO.DirectoryInfo]$Folder, [string]$Reason)
::PS::    if ($script:statusLineOpen) { Complete-CurrentStatus '6/6' '사용자 확인이 필요한 항목 발견' }
::PS::    Write-Host ''
::PS::    Write-Host '[확인 필요] 자동 판단하기 애매한 폴더를 발견했습니다.' -ForegroundColor Yellow
::PS::    Write-Host ('사유: ' + $Reason)
::PS::    Write-Host ('생성 시각: ' + $Folder.CreationTime.ToString('yyyy-MM-dd HH:mm:ss'))
::PS::    Write-Host ('폴더 경로: ' + $Folder.FullName)
::PS::    if (Wait-ForEnterOrEscape '폴더 전체를 삭제 후보에 포함하려면 Enter, 제외하려면 Esc: ') {
::PS::        Write-Host '[승인] 폴더 전체를 삭제 후보에 포함합니다.'
::PS::        return $true
::PS::    }
::PS::    [void]$excludedAmbiguous.Add($Folder.FullName)
::PS::    Write-Host '[제외] 폴더 자체는 제외하고, 현재 검색 지점부터 내부 항목 검토를 이어갑니다.'
::PS::    return $false
::PS::}
::PS::
::PS::function Search-Tree {
::PS::    param([string]$StartPath, [bool]$TrustedLocation, [bool]$CheckStartFolder)
::PS::    $stack = New-Object 'System.Collections.Generic.Stack[object]'
::PS::    $start = Get-Item -LiteralPath $StartPath -Force -ErrorAction SilentlyContinue
::PS::    if (-not $start) { return }
::PS::    $startKnownTraining = Test-IsKnownTrainingName $start.Name
::PS::    $startInTime = $start.CreationTime -ge $cutoff -and $start.CreationTime -le $now
::PS::    if ($CheckStartFolder -and ($startInTime -or $startKnownTraining)) {
::PS::        $approved = $startKnownTraining
::PS::        if (-not $approved) { $approved = Request-AmbiguousFolder $start '기존 사용자 검색 위치 밖에서 발견된 신규 폴더' }
::PS::        if ($approved) {
::PS::            if (Test-ContainsOriginalBatch $start.FullName) {
::PS::                $script:deferredBatchFolder = $start.FullName
::PS::                $TrustedLocation = $true
::PS::            } else {
::PS::                Add-CleanupTarget $start
::PS::                return
::PS::            }
::PS::        }
::PS::    }
::PS::    $stack.Push([pscustomobject]@{ Path = $start.FullName; Trusted = $TrustedLocation })
::PS::    while ($stack.Count -gt 0) {
::PS::        $current = $stack.Pop()
::PS::        Set-CurrentStatus '6/6' ('폴더 검색 중: ' + $current.Path)
::PS::        try {
::PS::            $children = @(Get-ChildItemSafe $current.Path)
::PS::        } catch {
::PS::            if (Test-IsPermissionFailure $_.Exception) {
::PS::                Register-PermissionSkip ('폴더 검색: ' + $current.Path)
::PS::            } else {
::PS::                [void]$issues.Add(('폴더 검색 실패: ' + $current.Path + ' - ' + $_.Exception.Message))
::PS::            }
::PS::            continue
::PS::        }
::PS::        foreach ($item in $children) {
::PS::            $itemPath = [IO.Path]::GetFullPath((Get-NormalPath $item.FullName)).TrimEnd('\')
::PS::            if ($itemPath -ieq $BatchPath) { continue }
::PS::            if (Test-IsSecurityDecoy $item) { [void]$decoySkips.Add($item.FullName); continue }
::PS::            $inTime = $item.CreationTime -ge $cutoff -and $item.CreationTime -le $now
::PS::            $knownTraining = Test-IsKnownTrainingName $item.Name
::PS::            if (-not $item.PSIsContainer) {
::PS::                if ($inTime -or $knownTraining) { Add-CleanupTarget $item }
::PS::                continue
::PS::            }
::PS::            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
::PS::            if ($inTime -or $knownTraining) {
::PS::                $approved = $current.Trusted -or $knownTraining
::PS::                if (-not $approved) { $approved = Request-AmbiguousFolder $item '기존 사용자 검색 위치 밖에서 발견된 신규 폴더' }
::PS::                if ($approved) {
::PS::                    if (Test-ContainsOriginalBatch $item.FullName) {
::PS::                        if (-not $script:deferredBatchFolder) { $script:deferredBatchFolder = $item.FullName }
::PS::                        $stack.Push([pscustomobject]@{ Path = $item.FullName; Trusted = $true })
::PS::                    } else {
::PS::                        Add-CleanupTarget $item
::PS::                    }
::PS::                    continue
::PS::                }
::PS::            }
::PS::            $stack.Push([pscustomobject]@{ Path = $item.FullName; Trusted = $current.Trusted })
::PS::        }
::PS::    }
::PS::}
::PS::
::PS::foreach ($root in $roots) {
::PS::    $isCore = $coreRootPaths -icontains $root
::PS::    Set-CurrentStatus '6/6' ('검색 위치 시작: ' + $root) -Force
::PS::    Search-Tree $root $isCore (-not $isCore)
::PS::}
::PS::
::PS::$systemDriveRoot = ([IO.Path]::GetPathRoot($env:SystemDrive + '\')).TrimEnd('\') + '\'
::PS::$protectedRootNames = @(
::PS::    'Windows', 'Users', 'Program Files', 'Program Files (x86)', 'ProgramData',
::PS::    '$Recycle.Bin', 'System Volume Information', 'Recovery', 'PerfLogs',
::PS::    'Documents and Settings', 'Boot', 'Config.Msi', 'MSOCache',
::PS::    'Intel', 'AMD', 'NVIDIA'
::PS::)
::PS::$protectedRootFiles = @(
::PS::    'pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'bootmgr',
::PS::    'BOOTNXT', 'DumpStack.log', 'DumpStack.log.tmp'
::PS::)
::PS::$blockedAttributes = [IO.FileAttributes]::System -bor [IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::ReparsePoint
::PS::if (Test-Path -LiteralPath $systemDriveRoot -PathType Container) {
::PS::    Set-CurrentStatus '6/6' ('C드라이브 최상위 항목 검색 중: ' + $systemDriveRoot) -Force
::PS::    try { $rootItems = @(Get-ChildItem -LiteralPath $systemDriveRoot -Force -ErrorAction Stop) }
::PS::    catch {
::PS::        $rootItems = @()
::PS::        if (Test-IsPermissionFailure $_.Exception) {
::PS::            Register-PermissionSkip 'C드라이브 최상위 검색'
::PS::        } else {
::PS::            [void]$issues.Add(('C드라이브 최상위 검색 실패: ' + $_.Exception.Message))
::PS::        }
::PS::    }
::PS::    foreach ($item in $rootItems) {
::PS::        Set-CurrentStatus '6/6' ('C드라이브 최상위 항목 확인 중: ' + $item.FullName)
::PS::        if ($protectedRootNames -icontains $item.Name) { continue }
::PS::        if ($protectedRootFiles -icontains $item.Name) { continue }
::PS::        if (($item.Attributes -band $blockedAttributes) -ne 0) { continue }
::PS::        if (Test-IsSecurityDecoy $item) { [void]$decoySkips.Add($item.FullName); continue }
::PS::        if ($item.PSIsContainer) {
::PS::            $overlapsSearchRoot = $false
::PS::            foreach ($searchRoot in $roots) {
::PS::                if ((Test-IsSameOrChildPath $searchRoot $item.FullName) -or (Test-IsSameOrChildPath $item.FullName $searchRoot)) {
::PS::                    $overlapsSearchRoot = $true
::PS::                    break
::PS::                }
::PS::            }
::PS::            if ($overlapsSearchRoot) { continue }
::PS::        }
::PS::        $knownTraining = Test-IsKnownTrainingName $item.Name
::PS::        $inTime = $item.CreationTime -ge $cutoff -and $item.CreationTime -le $now
::PS::        if (-not $inTime -and -not $knownTraining) { continue }
::PS::        if ($targetPaths.Contains([IO.Path]::GetFullPath($item.FullName).TrimEnd('\'))) { continue }
::PS::        if ($item.PSIsContainer) {
::PS::            $approved = $knownTraining
::PS::            if ($approved) {
::PS::                Complete-CurrentStatus '6/6' '삼성 DS 실습자료 이름 자동 승인'
::PS::                Write-Host ('[자동 승인] 삼성 DS 실습자료 폴더: ' + $item.FullName)
::PS::            } else {
::PS::                $approved = Request-AmbiguousFolder $item 'C드라이브 바로 아래에서 발견된 신규 폴더'
::PS::            }
::PS::            if ($approved) {
::PS::                if (Test-ContainsOriginalBatch $item.FullName) {
::PS::                    if (-not $deferredBatchFolder) { $deferredBatchFolder = $item.FullName }
::PS::                    Search-Tree $item.FullName $true $false
::PS::                } else {
::PS::                    Add-CleanupTarget $item
::PS::                }
::PS::            }
::PS::        } elseif (Test-IsOrdinaryDataFile $item) {
::PS::            Add-CleanupTarget $item
::PS::        } else {
::PS::            Complete-CurrentStatus '6/6' 'C드라이브 신규 파일 사용자 확인 필요'
::PS::            Write-Host ''
::PS::            Write-Host '[확인 필요] C드라이브 바로 아래의 신규 파일을 안전하게 자동 분류할 수 없습니다.' -ForegroundColor Yellow
::PS::            Write-Host ('생성 시각: ' + $item.CreationTime.ToString('yyyy-MM-dd HH:mm:ss'))
::PS::            Write-Host ('파일 경로: ' + $item.FullName)
::PS::            if (Wait-ForEnterOrEscape '삭제 후보에 포함하려면 Enter, 제외하려면 Esc: ') {
::PS::                Add-CleanupTarget $item
::PS::            } else {
::PS::                [void]$excludedAmbiguous.Add($item.FullName)
::PS::            }
::PS::        }
::PS::    }
::PS::}
::PS::Complete-CurrentStatus '6/6' '삭제 후보 검색 완료'
::PS::
::PS::Write-Host ''
::PS::Write-Host ('기준 시간: ' + $cutoff.ToString('yyyy-MM-dd HH:mm:ss') + ' 이후') -ForegroundColor Cyan
::PS::Write-Host ('확인 시간: ' + $now.ToString('yyyy-MM-dd HH:mm:ss')) -ForegroundColor Cyan
::PS::Write-Host '검색한 위치:'
::PS::foreach ($root in $roots) { Write-Host ('  ' + $root) }
::PS::Write-Host ('  ' + $systemDriveRoot + ' 바로 아래만 검색, 하위 폴더 미검색')
::PS::Write-Host ''
::PS::$sortedTargets = @($targets | Sort-Object FullName)
::PS::$deleteManifest = New-Object 'System.Collections.Generic.List[System.IO.FileSystemInfo]'
::PS::$manifestPaths = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
::PS::foreach ($target in $sortedTargets) {
::PS::    if (-not $target.PSIsContainer) {
::PS::        if ($manifestPaths.Add($target.FullName)) { [void]$deleteManifest.Add($target) }
::PS::        continue
::PS::    }
::PS::    $inventoryStack = New-Object 'System.Collections.Generic.Stack[string]'
::PS::    $inventoryStack.Push($target.FullName)
::PS::    while ($inventoryStack.Count -gt 0) {
::PS::        $inventoryPath = $inventoryStack.Pop()
::PS::        Set-CurrentStatus '6/6' ('삭제 목록 작성 중: ' + $inventoryPath)
::PS::        try {
::PS::            $inventoryChildren = @(Get-ChildItemSafe $inventoryPath)
::PS::        } catch {
::PS::            if (Test-IsPermissionFailure $_.Exception) {
::PS::                Register-PermissionSkip ('삭제 목록 작성: ' + $inventoryPath)
::PS::                [void]$permissionBlockedPaths.Add($inventoryPath)
::PS::            } else {
::PS::                [void]$issues.Add(('삭제 목록 작성 실패: ' + $inventoryPath + ' - ' + $_.Exception.Message))
::PS::            }
::PS::            continue
::PS::        }
::PS::        foreach ($child in $inventoryChildren) {
::PS::            if ($manifestPaths.Add($child.FullName)) { [void]$deleteManifest.Add($child) }
::PS::            if ($child.PSIsContainer -and (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)) {
::PS::                $inventoryStack.Push($child.FullName)
::PS::            }
::PS::        }
::PS::    }
::PS::    if ($manifestPaths.Add($target.FullName)) { [void]$deleteManifest.Add($target) }
::PS::}
::PS::Complete-CurrentStatus '6/6' ('삭제 목록 작성 완료: ' + $deleteManifest.Count + '개')
::PS::$displayManifest = @($deleteManifest | Sort-Object FullName)
::PS::# $manifestPaths에서 이미 전체 경로 중복을 제거했으므로 표시용 중복 제거 목록은 만들지 않는다.
::PS::$displayFolders = @($displayManifest | Where-Object { $_.PSIsContainer } | Sort-Object FullName)
::PS::# 원본 BAT 이 들어있는 폴더는 마지막에 별도 경로로 삭제되므로 삭제 목록($deleteManifest)에
::PS::# 들어가지 않는다. 같은 목록에 섞어 출력하면 표시된 폴더 수와 "총 실제 삭제 항목" 개수가
::PS::# 어긋나므로 별도 목록으로 분리해 따로 보여준다.
::PS::$deferredFolderList = New-Object 'System.Collections.Generic.List[System.IO.DirectoryInfo]'
::PS::$deferredFolderPaths = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
::PS::if ($deferredBatchFolder -and (Test-Path -LiteralPath $deferredBatchFolder -PathType Container)) {
::PS::    $deferredFolderStack = New-Object 'System.Collections.Generic.Stack[string]'
::PS::    $deferredFolderStack.Push($deferredBatchFolder)
::PS::    while ($deferredFolderStack.Count -gt 0) {
::PS::        $deferredPath = $deferredFolderStack.Pop()
::PS::        $deferredItem = Get-Item -LiteralPath $deferredPath -Force -ErrorAction SilentlyContinue
::PS::        if ($deferredItem -and $deferredFolderPaths.Add($deferredItem.FullName)) { [void]$deferredFolderList.Add($deferredItem) }
::PS::        try {
::PS::            $deferredChildren = @(Get-ChildItemSafe $deferredPath -Directory)
::PS::        } catch {
::PS::            if (Test-IsPermissionFailure $_.Exception) {
::PS::                Register-PermissionSkip ('BAT 포함 폴더 표시 목록 작성: ' + $deferredPath)
::PS::            } else {
::PS::                [void]$issues.Add(('BAT 포함 폴더 표시 목록 작성 실패: ' + $deferredPath + ' - ' + $_.Exception.Message))
::PS::            }
::PS::            continue
::PS::        }
::PS::        foreach ($childFolder in $deferredChildren) {
::PS::            if (($childFolder.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
::PS::                $deferredFolderStack.Push($childFolder.FullName)
::PS::            } elseif ($deferredFolderPaths.Add($childFolder.FullName)) {
::PS::                [void]$deferredFolderList.Add($childFolder)
::PS::            }
::PS::        }
::PS::    }
::PS::}
::PS::$deferredFolders = @($deferredFolderList | Sort-Object FullName)
::PS::$displayStandaloneFiles = @($sortedTargets | Where-Object { -not $_.PSIsContainer } | Sort-Object FullName)
::PS::if ($displayManifest.Count -gt 0) {
::PS::    Write-Host '삭제 범위(최하위 폴더 경로까지 표시):' -ForegroundColor Yellow
::PS::    foreach ($folder in $displayFolders) {
::PS::        Write-Host ('  [폴더] ' + $folder.FullName)
::PS::    }
::PS::    foreach ($file in $displayStandaloneFiles) {
::PS::        Write-Host ('  [개별 파일] ' + $file.FullName)
::PS::    }
::PS::    Write-Host ('총 실제 삭제 항목: ' + $displayManifest.Count + '개 (내부 파일 포함)') -ForegroundColor Cyan
::PS::} else {
::PS::    Write-Host '조건에 맞는 일반 삭제 대상이 없습니다.' -ForegroundColor Yellow
::PS::}
::PS::if ($deferredBatchFolder) {
::PS::    Write-Host ('  [마지막 삭제 보류] 원본 BAT 포함 폴더: ' + $deferredBatchFolder) -ForegroundColor Cyan
::PS::    foreach ($deferredFolder in $deferredFolders) {
::PS::        if ((Get-NormalPath $deferredFolder.FullName) -ine $deferredBatchFolder) {
::PS::            Write-Host ('    [하위 폴더] ' + $deferredFolder.FullName) -ForegroundColor Cyan
::PS::        }
::PS::    }
::PS::    Write-Host '    위 폴더와 그 안의 모든 파일은 다른 항목을 모두 지운 뒤 마지막에 삭제됩니다.' -ForegroundColor Cyan
::PS::}
::PS::if ($excludedAmbiguous.Count -gt 0) {
::PS::    Write-Host ''
::PS::    Write-Host '사용자가 제외한 폴더:' -ForegroundColor Cyan
::PS::    foreach ($path in $excludedAmbiguous) { Write-Host ('  [제외] ' + $path) }
::PS::}
::PS::Write-Host ''
::PS::if ($displayManifest.Count -gt 0 -or $deferredBatchFolder) {
::PS::    Write-Host '위 항목과 해당 폴더 안의 모든 내용은 영구 삭제됩니다.' -ForegroundColor Yellow
::PS::}
::PS::
::PS::$failures = New-Object 'System.Collections.Generic.List[string]'
::PS::$deleteTargets = @($displayManifest | Sort-Object { $_.FullName.Length } -Descending)
::PS::$deletedCount = 0
::PS::$index = 0
::PS::$barWidth = 30
::PS::$progressUpdateStep = [Math]::Max(1, [Math]::Ceiling($deleteTargets.Count / 1000.0))
::PS::foreach ($target in $deleteTargets) {
::PS::    $index++
::PS::    $deleteResult = Remove-PathWithLockRecovery $target
::PS::    if ($deleteResult.Status -eq 'Deleted') {
::PS::        $deletedCount++
::PS::    } else {
::PS::        $blockedByPermissionChild = $false
::PS::        if ($target.PSIsContainer) {
::PS::            $targetPrefix = [IO.Path]::GetFullPath($target.FullName).TrimEnd('\') + '\'
::PS::            foreach ($blockedPath in $permissionBlockedPaths) {
::PS::                $blockedFullPath = [IO.Path]::GetFullPath($blockedPath).TrimEnd('\')
::PS::                if (($blockedFullPath + '\').StartsWith($targetPrefix, [StringComparison]::OrdinalIgnoreCase)) {
::PS::                    $blockedByPermissionChild = $true
::PS::                    break
::PS::                }
::PS::            }
::PS::        }
::PS::        if ($deleteResult.Status -eq 'Permission' -or $blockedByPermissionChild) {
::PS::            Register-PermissionSkip ('실습자료 삭제: ' + $target.FullName)
::PS::            [void]$permissionBlockedPaths.Add($target.FullName)
::PS::        } else {
::PS::            $failureMessage = $target.FullName
::PS::            if ($deleteResult.Exception -and $deleteResult.Exception.Message) {
::PS::                $failureMessage += ' - ' + $deleteResult.Exception.Message
::PS::            }
::PS::            [void]$failures.Add($failureMessage)
::PS::        }
::PS::    }
::PS::    if ($index -eq 1 -or ($index % $progressUpdateStep) -eq 0 -or $index -eq $deleteTargets.Count) {
::PS::        $ratio = $index / [double]$deleteTargets.Count
::PS::        $percent = $ratio * 100
::PS::        $filled = [Math]::Min($barWidth, [Math]::Floor($ratio * $barWidth))
::PS::        $bar = ('#' * $filled) + ('-' * ($barWidth - $filled))
::PS::        $currentParent = if ($target.PSIsContainer) { $target.FullName } else { [IO.Path]::GetDirectoryName($target.FullName) }
::PS::        $currentFolderName = Split-Path -Leaf $currentParent
::PS::        if (-not $currentFolderName) { $currentFolderName = $currentParent }
::PS::        $progressLine = ('삭제 진행 [{0}] {1,6:N2}% ({2}/{3}) | {4}' -f $bar, $percent, $index, $deleteTargets.Count, $currentFolderName)
::PS::        $progressLog = ('삭제 진행 {0:N2}% ({1}/{2}) | {3}' -f $percent, $index, $deleteTargets.Count, $currentParent)
::PS::        Set-CurrentStatus '6/6' $progressLine -LogDetail $progressLog -RawDisplay -Force
::PS::    }
::PS::}
::PS::if ($deleteTargets.Count -gt 0) { Complete-CurrentStatus '6/6' ('실제 삭제 처리 완료: ' + $deletedCount + '/' + $deleteTargets.Count + '개') }
::PS::if ($failures.Count -gt 0) {
::PS::    foreach ($path in $failures) { [void]$issues.Add(('실습자료 삭제 실패: ' + $path)) }
::PS::}
::PS::Write-Host ('삭제 완료 항목: ' + $deletedCount + '개')
::PS::
::PS::Write-Host ''
::PS::if ($issues.Count -eq 0) {
::PS::    if ($deferredBatchFolder) {
::PS::        $deferredPermissionBlocked = $false
::PS::        try {
::PS::            Set-CurrentStatus '6/6' ('원본 BAT 포함 폴더의 파일 확인 중: ' + $deferredBatchFolder) -Force
::PS::            $deferredItems = @(Get-ChildItemSafe $deferredBatchFolder -Recurse | Where-Object { (Get-NormalPath $_.FullName) -ine $BatchPath })
::PS::        } catch {
::PS::            $deferredItems = @()
::PS::            Complete-CurrentStatus '6/6' '원본 BAT 포함 폴더 확인 중 문제 발생'
::PS::            if (Test-IsPermissionFailure $_.Exception) {
::PS::                Register-PermissionSkip ('원본 BAT 포함 폴더 확인: ' + $deferredBatchFolder)
::PS::                $deferredPermissionBlocked = $true
::PS::            } else {
::PS::                [void]$issues.Add(('원본 BAT 포함 폴더 확인 실패: ' + $deferredBatchFolder + ' - ' + $_.Exception.Message))
::PS::            }
::PS::        }
::PS::        foreach ($deferredFile in @($deferredItems | Where-Object { -not $_.PSIsContainer } | Sort-Object { $_.FullName.Length } -Descending)) {
::PS::            Set-CurrentStatus '6/6' ('원본 BAT 포함 폴더 파일 삭제 중: ' + $deferredFile.FullName)
::PS::            $deferredResult = Remove-PathWithLockRecovery $deferredFile
::PS::            if ($deferredResult.Status -eq 'Permission') {
::PS::                Register-PermissionSkip ('원본 BAT 포함 폴더 파일 삭제: ' + $deferredFile.FullName)
::PS::                $deferredPermissionBlocked = $true
::PS::            } elseif ($deferredResult.Status -ne 'Deleted') {
::PS::                $deferredFailure = '원본 BAT 포함 폴더 파일 삭제 실패: ' + $deferredFile.FullName
::PS::                if ($deferredResult.Exception -and $deferredResult.Exception.Message) { $deferredFailure += ' - ' + $deferredResult.Exception.Message }
::PS::                [void]$issues.Add($deferredFailure)
::PS::            }
::PS::        }
::PS::        if ($issues.Count -eq 0 -and -not $deferredPermissionBlocked) {
::PS::            if (-not (Remove-OriginalBatch)) {
::PS::                [void]$issues.Add(('원본 초기화 BAT 삭제 실패: ' + $BatchPath))
::PS::            }
::PS::            # Remove-OriginalBatch 는 권한 부족일 때 BAT을 남기면서도 $true 를 반환한다.
::PS::            # 그 상태로 다음 블록에 들어가면 원본이 들어있는 폴더를 삭제하러 가서
::PS::            # 방금 보존하기로 한 BAT까지 지우거나 프롬프트로 멈춘다.
::PS::            # 반환값이 아니라 실제 파일 존재 여부로 다시 확인한다.
::PS::            if (Test-Path -LiteralPath $BatchPath) { $deferredPermissionBlocked = $true }
::PS::        }
::PS::        if ($issues.Count -eq 0 -and -not $deferredPermissionBlocked) {
::PS::            foreach ($deferredDirectory in @($deferredItems | Where-Object { $_.PSIsContainer } | Sort-Object { $_.FullName.Length } -Descending)) {
::PS::                try {
::PS::                    # 하위 항목은 이미 개별 처리했으므로 빈 폴더 하나만 삭제한다.
::PS::                    # 재귀 삭제를 사용하면 잠긴 하위 파일의 확인/진행률을 우회할 수 있다.
::PS::                    Remove-ItemSafe $deferredDirectory.FullName
::PS::                }
::PS::                catch {
::PS::                    if (Test-IsPermissionFailure $_.Exception) {
::PS::                        Register-PermissionSkip ('원본 BAT 포함 하위 폴더 삭제: ' + $deferredDirectory.FullName)
::PS::                        $deferredPermissionBlocked = $true
::PS::                    } else {
::PS::                        [void]$issues.Add(('원본 BAT 포함 하위 폴더 삭제 실패: ' + $deferredDirectory.FullName + ' - ' + $_.Exception.Message))
::PS::                    }
::PS::                }
::PS::            }
::PS::        }
::PS::        if ($issues.Count -eq 0 -and -not $deferredPermissionBlocked) {
::PS::            try {
::PS::                Set-CurrentStatus '6/6' ('원본 BAT 포함 폴더 마지막 삭제 중: ' + $deferredBatchFolder) -Force
::PS::                # 원본 BAT와 하위 항목이 모두 처리된 뒤 빈 최상위 폴더 하나만 삭제한다.
::PS::                Remove-ItemSafe $deferredBatchFolder
::PS::                Complete-CurrentStatus '6/6' '원본 BAT 포함 폴더 삭제 완료'
::PS::                Write-Host ('[완료] 원본 BAT 포함 폴더 삭제: ' + $deferredBatchFolder)
::PS::            } catch {
::PS::                Complete-CurrentStatus '6/6' '원본 BAT 포함 폴더 삭제 중 문제 발생'
::PS::                if (Test-IsPermissionFailure $_.Exception) {
::PS::                    Register-PermissionSkip ('원본 BAT 포함 폴더 삭제: ' + $deferredBatchFolder)
::PS::                } else {
::PS::                    [void]$issues.Add(('원본 BAT 포함 폴더 삭제 실패: ' + $deferredBatchFolder + ' - ' + $_.Exception.Message))
::PS::                }
::PS::            }
::PS::        }
::PS::        if ($issues.Count -gt 0 -or $deferredPermissionBlocked) { [void](Restore-OriginalBatch) }
::PS::    } elseif (-not (Remove-OriginalBatch)) {
::PS::        [void]$issues.Add(('원본 초기화 BAT 삭제 실패: ' + $BatchPath))
::PS::    }
::PS::} else {
::PS::    [void](Restore-OriginalBatch)
::PS::}
::PS::Complete-CurrentStatus '6/6' '모든 정리 작업 종료 및 결과 확인 중'
::PS::
::PS::if ($lockEvents.Count -gt 0) {
::PS::    Write-Host ('파일 잠금 처리 기록: ' + $lockEvents.Count + '개') -ForegroundColor Cyan
::PS::    foreach ($lockEvent in @($lockEvents | Sort-Object -Unique)) { Write-Host ('  [잠금] ' + $lockEvent) }
::PS::}
::PS::
::PS::if ($decoySkips.Count -gt 0) {
::PS::    Write-Host ('[안내] 백신 디코이(미끼)로 판단해 삭제 대상에서 제외: ' + $decoySkips.Count + '개') -ForegroundColor Cyan
::PS::    foreach ($decoyPath in @($decoySkips | Sort-Object)) { Write-Host ('  [제외] ' + $decoyPath) -ForegroundColor Cyan }
::PS::    Write-Host '  보안 프로그램이 자동으로 만들고 복구하는 항목입니다. 교육자료가 아닙니다.' -ForegroundColor Cyan
::PS::}
::PS::
::PS::if ($permissionSkips.Count -gt 0) {
::PS::    Write-Host ('[안내] 권한 부족으로 건너뛴 작업: ' + $permissionSkips.Count + '개 (실패로 처리하지 않음)') -ForegroundColor Yellow
::PS::    foreach ($skipDescription in @($permissionSkips | Sort-Object)) {
::PS::        Write-Host ('  [건너뜀] ' + $skipDescription) -ForegroundColor Yellow
::PS::    }
::PS::    Write-Host '  관리자 권한으로 실행했는데도 접근할 수 없어 남은 항목입니다. 필요하면 수동으로 확인하세요.' -ForegroundColor Yellow
::PS::}
::PS::
::PS::if ($issues.Count -eq 0) {
::PS::    Write-Host '교육 종료 초기화가 완료되었습니다.' -ForegroundColor Green
::PS::    Write-Host 'Claude 로그인은 유지됩니다.'
::PS::    Write-Host '임시 실행 파일을 정리한 뒤 Windows를 종료합니다.' -ForegroundColor Cyan
::PS::    $exitCode = 0
::PS::} else {
::PS::    Write-Host '완료되지 않은 작업:' -ForegroundColor Red
::PS::    foreach ($message in @($issues | Sort-Object -Unique)) { Write-Host ('  [실패] ' + $message) -ForegroundColor Red }
::PS::    Write-Host '문제가 발생해 원본 BAT와 그 폴더를 보존했습니다. 위 항목을 확인한 뒤 다시 실행하세요.' -ForegroundColor Yellow
::PS::    Write-Host '아무 키나 누르면 창이 닫힙니다.'
::PS::    [void][Console]::ReadKey($true)
::PS::    $exitCode = 1
::PS::}
::PS::Set-CompletionMarker
::PS::exit $exitCode
