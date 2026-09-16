# Hardware-only remaining items

この一覧は、物理 Raspberry Pi / 実NIC / 実kernel がないと完了判定できない項目だけです。
ソフトウェアで検証できる build、test、CI、deploy package、smoke path はここへ退避しません。

- Pi A/Pi B の実機で `eth0` の実interface名、MTU、CPU governor、kernel release が run に正しく記録されることを確認する。
- Pi B の実NICで XDP `native` attach が成功するか確認する。失敗して `generic` にfallbackする場合は、その attach mode の結果として記録し、native の結果と混ぜない。
- Pi A が既定pps steps `500,2000,5000,10000,20000,50000` を各rateで90%以上送信できるか確認する。
- 展示用隔離Ethernet LANで、Pi A の UDP load と Pi A→Pi B HTTP probe が Wi-Fi や外部Internetを経由していないことを確認する。
- 実験中の Pi B thermal throttling / power supply / NIC driver の影響を観察し、必要なら結果注記に残す。
- 3 repetitions の実測値で非単調な pass/fail が出た場合、プロトコル通り再測定する。
