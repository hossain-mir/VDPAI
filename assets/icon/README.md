# VDPAI launcher icon — owner-supplied artwork

The final launcher icon is **not included in this repository**. The Android
resources currently contain a neutral, obviously temporary placeholder.

## Supply the final icon

1. Save a square PNG as `assets/icon/icon.png` (1024×1024 recommended). Alpha
   transparency is supported; do not add a separate background.
2. Run:

   ```bash
   npm run assets
   ```

3. Rebuild the APK (`npm run build && npm run cap:sync`, then
   `cd android && ./gradlew assembleDebug`).

The import script copies the PNG **byte-for-byte** into the Android resources.
It does not crop, recolour, redraw or add a background. The adaptive-icon
foreground is inset by 18% per side so launcher masks do not cut off the
artwork. The same source is used for the legacy, round and adaptive icons.

## Review before release

Android launchers apply a circular, squircle or rounded-square mask to adaptive
icons. Keep important artwork inside the central safe zone, and check the result
on a launcher before publishing. If the artwork needs different padding, edit
`android:inset` in the generated
`android/app/src/main/res/drawable/ic_launcher_user_inset.xml` and rebuild.

Do not commit a real icon until the owner approves the artwork.
