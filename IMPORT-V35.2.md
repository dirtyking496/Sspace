# Importer et valider SSPACE V35.2

1. Dans ce dépôt, utilisez **Add file > Upload files**.
2. Téléversez à la racine le fichier exact `SSPACE_V35.2_NEON_ORBIT.zip`.
3. Committez sur `main`.
4. Le workflow **SSPACE V35.2 build verification** s'exécute automatiquement. Il extrait cette archive, détecte le package racine, installe les dépendances et lance `npm run build`.
5. Consultez l'onglet Actions et vérifiez que le run est terminé avec succès.

Le workflow a été préparé pour cette archive, mais l'archive elle-même doit encore être téléversée dans le dépôt. Aucun build V35.2 n'est déclaré réussi tant que GitHub Actions ne l'a pas exécuté.
