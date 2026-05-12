* Later / snooze functionality...
    * Dersom vi har reminder vis ikon på tasklinja
* NOTIFICATIONS!
* Print
* Share
  - generere en unik link på stuf-server som hoster tasken
  - Skal vi kunne import også?
* Sync push race condition (kan gi bidirectional drift mellom aktive enheter)
  - `sync.js` `pushChanges` og `pushAllLocalChanges` kaller `clearUnpushedChanges()` som wiper hele IDB-storen
  - To race-vinduer: (a) failed push lar en orphan ligge i IDB, neste vellykkede push wiper den; (b) ny localChange under push havner i IDB men wipes av samme clearUnpushed
  - Recovery finnes: "Recover Sync"-knappen i Settings → Sync (kalles på hver berørte enhet)
  - Fix-skisse: returner `{id, change}` fra `getUnpushedChanges()`, ny `deleteUnpushedChanges(ids)`, dropp `_pushQueue` og les fra IDB. Bruk dirty-flag-mønster + recheck i finally for å close race rundt flag-reset
  - Forsiktig fordi kritisk sti — bør ha tester før endring
