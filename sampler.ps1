# Memory sampler for the DSH resource strip.
# Prints one compact JSON line every $IntervalMs milliseconds:
#   {"physTotal":..,"physAvail":..,"commitLimit":..,"commitAvail":..,"load":..}
# All sizes are bytes. ASCII only: this file is read by PowerShell 5.1, which
# assumes ANSI when a file has no BOM.
param([int]$IntervalMs = 2000)

$ErrorActionPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class DshMemSampler
{
    [StructLayout(LayoutKind.Sequential)]
    public struct MEMORYSTATUSEX
    {
        public uint dwLength;
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile;
        public ulong ullAvailPageFile;
        public ulong ullTotalVirtual;
        public ulong ullAvailVirtual;
        public ulong ullAvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX lpBuffer);
}
'@

$status = New-Object 'DshMemSampler+MEMORYSTATUSEX'
$status.dwLength = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf([type]'DshMemSampler+MEMORYSTATUSEX')

while ($true) {
    if ([DshMemSampler]::GlobalMemoryStatusEx([ref]$status)) {
        $line = [ordered]@{
            physTotal   = [double]$status.ullTotalPhys
            physAvail   = [double]$status.ullAvailPhys
            commitLimit = [double]$status.ullTotalPageFile
            commitAvail = [double]$status.ullAvailPageFile
            load        = [int]$status.dwMemoryLoad
            at          = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        } | ConvertTo-Json -Compress
        [Console]::Out.WriteLine($line)
        [Console]::Out.Flush()
    }
    Start-Sleep -Milliseconds $IntervalMs
}
