import { useState } from 'react'
import { Card, Group, NavLink, SegmentedControl, Stack, Text, Title } from '@mantine/core'
import { BookOpen } from 'lucide-react'
import { useI18n } from '../i18n/LanguageProvider'
import type { Lang } from '../i18n/strings'
import { USAGE_GUIDE, type GuideSectionId } from '../i18n/usage-guide'

/**
 * OWNER-ONLY how-to. Lives under Settings so cashiers never see a wall of text on the till.
 * Language can follow the shop setting or be flipped here for training (EN / اردو side by side).
 */
export function UsageGuidePanel(): React.JSX.Element {
  const { lang: shopLang, t } = useI18n()
  const [guideLang, setGuideLang] = useState<Lang>(shopLang)
  const sections = USAGE_GUIDE[guideLang]
  const [active, setActive] = useState<GuideSectionId>(sections[0]?.id ?? 'start')
  const current = sections.find((section) => section.id === active) ?? sections[0]

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start" wrap="wrap">
        <div>
          <Group gap="sm" mb={4}>
            <BookOpen size={22} />
            <Title order={3}>{t('settings.guide')}</Title>
          </Group>
          <Text size="sm" c="dimmed" maw={520}>
            {t('settings.guide.intro')}
          </Text>
        </div>

        <SegmentedControl
          value={guideLang}
          onChange={(value) => setGuideLang(value as Lang)}
          data={[
            { value: 'en', label: 'English' },
            { value: 'ur', label: 'اردو' }
          ]}
        />
      </Group>

      <Group align="flex-start" gap="lg" wrap="nowrap" style={{ alignItems: 'stretch' }}>
        <Card withBorder padding="sm" style={{ width: 260, flexShrink: 0 }}>
          <Stack gap={2}>
            {sections.map((section) => (
              <NavLink
                key={section.id}
                label={section.title}
                active={section.id === active}
                onClick={() => setActive(section.id)}
                styles={{
                  label: {
                    fontSize: 13,
                    whiteSpace: 'normal',
                    lineHeight: 1.35
                  }
                }}
              />
            ))}
          </Stack>
        </Card>

        <Card withBorder padding="lg" style={{ flex: 1, minWidth: 0 }}>
          {current && (
            <Stack gap="md" dir={guideLang === 'ur' ? 'rtl' : 'ltr'}>
              <Title order={4}>{current.title}</Title>
              <Stack gap="sm" component="ol" style={{ margin: 0, paddingInlineStart: '1.25rem' }}>
                {current.steps.map((step, index) => (
                  <Text key={index} component="li" size="sm" style={{ lineHeight: 1.55 }}>
                    {step}
                  </Text>
                ))}
              </Stack>
            </Stack>
          )}
        </Card>
      </Group>
    </Stack>
  )
}
