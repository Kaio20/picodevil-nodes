# Node-Konzept für NodesDevil

Der Compositor soll sich direkt am Graphen bedienen lassen. Jeder Node zeigt seine wichtigsten Regler und dieselben Werte lassen sich über Kabel steuern. Ein Patch kann damit vom statischen Bild zur Live-Animation wachsen, indem etwa ein LFO, der Transport oder ein Step Sequencer einen vorhandenen Regler übernimmt.

## Eingänge und Werte

| Typ | Verwendung | Bedienung am freien Eingang |
| --- | --- | --- |
| `Float` | Kontinuierliche Werte wie Faktor, Stärke, Radius oder Frequenz | Dezimalfeld mit Ziehen und Tastatureingabe |
| `Int` | Ganze Werte wie Anzahl, Index oder Wiederholungen | Ganzzahlfeld mit Ganzzahlschritten |
| `Bool` | Optionen wie Invertieren oder Begrenzen | Schalter |
| `Color` | Lineare RGBA-Farbe, bei Bedarf pro Pixel | Farbfeld mit Alpha |
| `Vec2` | Koordinaten und Versatz | Zwei Komponentenfelder |
| `Image` | Bildquelle oder Ergebnis eines Bildpasses | Je nach Node Medienwahl, Mini-Vorschau oder leerer Eingang |
| `String` | Zeichenfolge, etwa Inhalt oder Name | Textfeld |
| `Text` | Gestaltete Textebene mit Inhalt und Stil wie im klassischen Editor | Textebene über einen Anschluss |

Der vorhandene Float-Node gibt über **Type** einen `Float` oder `Integer` aus. Farbe speichert RGB und Alpha als einen gemeinsamen Wert. String und Text sind eigenständige Anschlusstypen. Eigene Nodes für Schriftgestaltung und Textausgabe gehören in einen späteren Ausbau.

Jeder Zahlenwert, der das Ergebnis steuert, bekommt einen typisierten Eingang. Die Eingabe sitzt in derselben Zeile wie der Anschluss. Bei einem Kabel zeigt die Zeile den verbundenen Zustand und bewahrt den lokalen Wert. Nach dem Lösen des Kabels gilt dieser Wert wieder. Name, Einheit, Default und Grenzen gehören zur Definition des Eingangs. Die Grenzen gelten für UI-Eingaben ebenso wie für Kabelwerte.

Ein Eingang kann einen Wert für den gesamten Frame oder ein Feld mit einem Wert pro Pixel akzeptieren. `Merge.Factor` kann etwa einen einzelnen LFO-Wert oder eine prozedurale Maske pro Pixel verwenden. `Tile UV.Columns` gilt für den gesamten Frame. Ein einzelner Wert lässt sich auf alle Pixel anwenden. Eine Reduktion vom Pixelfeld auf einen einzelnen Wert braucht eine eigene Operation.

Stopps hinzufügen und entfernen, eine Interpolationsart auswählen oder das Step-Raster öffnen sind Aktionen am Node. Die Werte, die daraus in die Berechnung eingehen, bleiben typisiert. Bei einem größeren Editor öffnet sich ein Pop-up, während eine kompakte Vorschau am Node sichtbar bleibt. Anschlüsse übernehmen die Typfarben aus dem klassischen Editor.

### Automatische Konvertierungen

| Verbindung | Ergebnis |
| --- | --- |
| `Bool → Float` | `false` ergibt 0, `true` ergibt 1. |
| `Float → Bool` | 0 ergibt `false`, andere endliche Werte ergeben `true`. |
| `Int → Float` | Übernimmt den Zahlenwert mit der Präzision des Float-Typs. |
| `Float → Int` | Für ausdrücklich dafür freigegebene Anzahl- und Indexeingänge. Rundet zur nächsten Ganzzahl, bei Gleichstand von null weg. Danach gelten die Grenzen des Eingangs. |
| `Float → Color` | Grauwert mit Alpha 1. |
| `Color → Float` | Luminanz der linearen RGB-Farbe, gewichtet mit Alpha. Bei intern vormultipliziertem RGB genügt die Luminanz daraus. |
| `Float → Vec2` | Derselbe Wert auf beiden Achsen. |
| `Color → Image` | Verwendet die Farbe als Fläche oder wertet das Farbfeld pro Pixel aus. |
| `Image → Float` | An dafür definierten Faktor- und Maskeneingängen liefert jeder Bildpunkt seine Luminanz gewichtet mit Alpha. |

Für eine gezielte Rundung stehen später `Round`, `Floor`, `Ceil` und `Truncate` in einem numerischen Konvertierungs-Node zur Verfügung. Der Kabel-Tooltip zeigt Quelltyp, Zieltyp und die tatsächlich angewandte Umwandlung, etwa **Image → Float · Luminanz × Alpha**. Der eigenständige Node `Alpha` liefert weiterhin die reine Deckkraft eines Bildes oder einer Farbe.

## Color Ramp

Die angehängte klassische Color Ramp zeigt, wie Verlauf, Stopps und Zahlenfeld direkt am Node zusammenwirken. Für den Compositor wird daraus ein einzelner Faktor-Eingang und ein Farbergebnis mit separat abgreifbarem Alpha.

- **Factor** ist ein `Float`-Eingang mit Default 0,5. Er akzeptiert Werte für den Frame ebenso wie Pixelfelder. Ein Bild kann über die Faktor-Konvertierung direkt angeschlossen werden.
- **Stopps** haben je eine feste ID, eine `Float`-Position zwischen 0 und 1 und eine RGBA-Farbe. Position und Farbe sind anschließbar und gelten zunächst pro Frame. Ein neuer Ramp-Node startet mit deckendem Schwarz bei 0 und deckendem Weiß bei 1.
- **Vorschau** zeigt den Verlauf über 0 bis 1 und lässt die Stopps direkt verschieben. Die Werte und Anschlüsse des ausgewählten Stopps bleiben erreichbar. Bei vielen Stopps öffnet ein Pop-up die vollständige Liste mit allen Anschlüssen. Außen angeschlossene, derzeit eingeklappte Stopps bleiben am Node als Anschlüsse erreichbar.
- **Interpolation** bietet zuerst `Linear` und `Constant`. Linear interpoliert die intern vormultiplizierten RGBA-Werte. Außerhalb der äußeren Stopps gilt die jeweilige Randfarbe. Bei gleicher Position entscheidet die gespeicherte Stopp-Reihenfolge. Am gemeinsamen Punkt gilt der spätere Stopp.

| Ausgang | Verwendung |
| --- | --- |
| `Color` | Hauptausgang. Liefert RGBA und lässt sich direkt an einen Farbeingang, über die Konvertierung an einen Bildeingang oder als Helligkeitsmaske an `Apply Mask.Mask` anschließen. |
| `Alpha` | Liefert die Deckkraft desselben Ramp-Ergebnisses. Ein durchgehend deckender Schwarz-Weiß-Verlauf liefert hier überall 1. Ein Verlauf mit transparenten Stopps kann als Deckkraftmaske dienen. |

Ein typischer Patch verbindet den `Time`-Node im Modus `Seconds` mit `Noise.Time` und den Noise-Ausgang mit `Color Ramp.Factor`. Für eine Helligkeitsmaske geht `Color Ramp.Color` direkt in `Apply Mask.Mask`. Für eine Maske aus den Deckkräften der Stopps geht `Color Ramp.Alpha` in denselben Eingang. Beide Ausgänge verwenden dieselbe Ramp-Auswertung.

## Vorschläge für die erste Node-Gruppe

| Node | Eingänge und Bedienung | Ausgänge und Einsatz |
| --- | --- | --- |
| **Float / Integer** | `Value` als Dezimal- bzw. Ganzzahlfeld | Je ein typisierter Wert für mehrere Regler, etwa gemeinsame Stärke oder Anzahl |
| **Map Range** | `Value`, `From Min/Max`, `To Min/Max` als `Float`, `Clamp` als `Bool`. Bei identischen Quellgrenzen gilt `To Min`. | `Value: Float`. Bringt etwa einen LFO in den Wertebereich eines Zooms oder Displacements. |
| **Posterize** | `Factor: Float` in 0–1. `Levels: Int` pro Frame, mindestens 2 und standardmäßig 4. | `Value: Float`. Stuft ein Signal in gleichmäßige Werte einschließlich 0 und 1 ab, etwa für eine harte Maske. |
| **Tile UV** | `UV: Vec2` mit Graph-UV als Default. `Columns` und `Rows` als `Int` pro Frame, jeweils mindestens 1. | `Local UV: Vec2` für wiederholte Texturen. `Column: Int` und `Row: Int` liefern nullbasierte Pixelfelder für Variationen pro Kachel. |
| **Image Select** | `A/B: Image`, `Index: Int` pro Frame, begrenzt auf 0–1. | `Image`. Schaltet mit 0 auf A und mit 1 auf B. Für harte BPM-synchrone Schnitte. |
| **Step Sequencer** | `Steps Per Beat: Float` größer als 0, `Length: Int` pro Frame zwischen 1 und der Zahl vorhandener Slots. Jeder Step hat einen `Float`-Wert. Das Pop-up bearbeitet das Raster, die Mini-Vorschau am Node zeigt den aktiven Step. | `Value: Float` für die aktuelle Stufe und `Index: Int` für die nullbasierte Position, etwa zum Umschalten von Bildern. |

Im ersten Ausbau kommen `Int`, freie Zahlenfelder am Eingang und `Map Range`. Color Ramp und Step Sequencer prüfen anschließend, wie mehrere Ausgänge und komplexere Regler am Node funktionieren. Posterize, Tile UV und Image Select nutzen diese Grundlagen für Shader und Live-Schnitte.

## Umsetzung im Compositor

Das aktuelle [Graph-Modell](src/compositor/graph.ts) verwaltet einen Ausgang pro Node. Mehrere Ausgänge brauchen stabile Port-IDs, damit ein Kabel auf `Color` oder `Alpha` zeigen kann und gespeicherte Patches durch ein Umbenennen im UI gültig bleiben. Bestehende Kabel werden beim Laden dem jeweiligen Hauptausgang zugeordnet, bei der bisherigen Ramp also `Color`. Die bisherigen Farb- und Positionspaare werden als Stopps übernommen. Das bisherige Ergebnis bei identischen Endpositionen bekommt einen eigenen Kompatibilitätstest.

[Graph-Validierung](src/compositor/graph.ts) und [WGSL-Compiler](src/compositor/compiler.ts) verwenden dieselben Konvertierungsregeln. `Int` entspricht im Shader einem vorzeichenbehafteten 32-Bit-Wert. Ein Anschluss deklariert, welche Typen und Felder er annehmen kann. Der Compiler kann Ausgänge aus derselben Berechnung ableiten und schreibt Zwischenbilder nur dort, wo ein Pass oder ein Abnehmer sie braucht. Änderungen an verbindungsfreien Werten für den gesamten Frame sollten, wo die Struktur gleich bleibt, als Uniform-Daten aktualisiert werden. Änderungen wirken zuerst im Entwurf. Ein gültiger **Take** übernimmt den vorbereiteten Stand in die Projektion.

## Abnahme für die spätere Umsetzung

- Ein `Float`-Feld akzeptiert 0,25 und ein `Int`-Feld arbeitet in Ganzzahlschritten. Ein LFO oder Step Sequencer übernimmt beide Beispielanschlüsse über die vorgesehenen Konvertierungen. Nach dem Lösen erscheint der vorherige lokale Wert.
- Die Rundung eines freigegebenen Int-Eingangs ergibt für 2,5 den Wert 3 und für −2,5 den Wert −3, jeweils vor der Begrenzung des Zielbereichs. Ein Pixelfeld am frameweiten `Index` wird beim Verbinden abgewiesen.
- Eine deckende Schwarz-Weiß-Ramp liefert am Color-Ausgang 0 bis 1 und am Alpha-Ausgang durchgehend 1. Ein transparenter Stopp wirkt über Alpha, und eine halbtransparente weiße Bildquelle liefert am Faktor-Eingang 0,5.
- Positionskabel bleiben den richtigen Stopps zugeordnet, wenn die Stopps einander kreuzen, der Node zuklappt oder der Patch erneut geladen wird. Das Step-Raster zeigt nach dem Laden dieselben Werte und läuft weiter synchron zum Transport.
- Beide Ramp-Ausgänge können gleichzeitig verwendet werden. Der Ausführungsplan nutzt die gemeinsame Berechnung, und ein gültiger Take schaltet auf den neuen Patch um, während die Clips und der Transport weiterlaufen.
